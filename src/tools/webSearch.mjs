/**
 * @import { Tool } from '../tool'
 * @import { CallModel } from '../model'
 */

import { execFile } from "node:child_process";
import { styleText } from "node:util";
import { getGoogleCloudAccessToken } from "../providers/platform/googleCloud.mjs";
import { noThrow } from "../utils/noThrow.mjs";

/**
 * @typedef {WebSearchToolGeminiOptions
 *   | WebSearchToolGeminiVertexAIOptions
 *   | WebSearchToolCommandOptions} WebSearchToolOptions
 */

/**
 * @typedef {Object} WebSearchToolGeminiOptions
 * @property {"gemini"} provider
 * @property {string=} baseURL
 * @property {string} apiKey
 * @property {string} model
 */

/**
 * @typedef {Object} WebSearchToolGeminiVertexAIOptions
 * @property {"gemini-vertex-ai"} provider
 * @property {string} baseURL
 * @property {string=} account
 * @property {string} model
 */

/**
 * Runtime configuration for the `command` provider.
 *
 * Runs `command` once per keyword set with `args` followed by the keywords
 * (no shell). `modelCaller` is injected by the caller (e.g., `main.mjs`)
 * using the agent's main model and is used to distil the combined results
 * down to entries relevant to `question`.
 *
 * @typedef {Object} WebSearchToolCommandOptions
 * @property {"command"} provider
 * @property {string} command Executable used to perform each search (e.g., a wrapper around a search API).
 * @property {string[]} args Arguments passed before the keywords (e.g., `["-n", "5"]`).
 * @property {number=} timeoutMs Per-search timeout in milliseconds (default 30000).
 * @property {Record<string, string>=} env Extra environment variables, merged on top of PATH / HOME / LANG.
 * @property {CallModel} modelCaller
 * @property {number=} maxLengthPerSearch Truncate each search's output to this many characters (default 50000).
 * @property {number=} maxTotalLength Truncate the combined output across searches to this many characters (default 200000).
 * @property {number=} delayBetweenRequestsMs Delay between each search request in milliseconds (default 1000).
 */

/**
 * @typedef {Object} WebSearch
 * @property {string[]} keywords
 */

/**
 * @typedef {Object} WebSearchInput
 * @property {WebSearch[]} searches
 * @property {string} question
 */

/** @type {number} */
const DEFAULT_MAX_LENGTH_PER_SEARCH = 50_000;

/** @type {number} */
const DEFAULT_MAX_TOTAL_LENGTH = 200_000;

/** @type {number} */
const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;

/** @type {number} */
const DEFAULT_DELAY_BETWEEN_REQUESTS_MS = 1_000;

/** @type {number} */
const SEARCH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * @param {WebSearchToolOptions} config
 * @returns {Tool}
 */
export function createWebSearchTool(config) {
  return {
    def: {
      name: "web_search",
      description:
        "Run one or more web searches and answer a question based on the combined results.",
      inputSchema: {
        type: "object",
        properties: {
          searches: {
            type: "array",
            description:
              "One or more searches to run. Each entry describes a single query.",
            items: {
              type: "object",
              properties: {
                keywords: {
                  type: "array",
                  description: "Keywords for this search query.",
                  items: { type: "string" },
                },
              },
              required: ["keywords"],
            },
          },
          question: {
            type: "string",
            description:
              "The question that the combined search results should answer.",
          },
        },
        required: ["searches", "question"],
      },
    },

    /**
     * @param {WebSearchInput} input
     * @returns {Promise<string | Error>}
     */
    impl: async (input) =>
      await noThrow(async () => {
        const validationError = validateInput(input);
        if (validationError) {
          return validationError;
        }
        switch (config.provider) {
          case "gemini":
          case "gemini-vertex-ai":
            return webSearchViaGemini(config, input, 0);
          case "command":
            return webSearchViaCommand(config, input);
        }
      }),

    /**
     * @param {Record<string, unknown>} _input
     * @returns {Record<string, unknown>}
     */
    maskApprovalInput: (_input) => {
      return {};
    },
  };
}

/**
 * Truncate `content` to at most `maxLength` characters, keeping the head.
 * When truncation occurs, a `[truncated: ...]` marker is appended.
 *
 * @param {string} content
 * @param {number} maxLength
 * @returns {{ text: string, truncated: boolean, originalLength: number }}
 */
export function truncateText(content, maxLength) {
  if (content.length <= maxLength) {
    return { text: content, truncated: false, originalLength: content.length };
  }
  const head = content.slice(0, maxLength);
  const truncatedLength = content.length - maxLength;
  return {
    text: `${head}\n\n[truncated: ${truncatedLength} of ${content.length} chars omitted]`,
    truncated: true,
    originalLength: content.length,
  };
}

/**
 * @param {WebSearchInput} input
 * @returns {Error | null}
 */
function validateInput(input) {
  if (!Array.isArray(input.searches) || input.searches.length === 0) {
    return new Error("`searches` is required and must be a non-empty array.");
  }
  for (const search of input.searches) {
    if (!search || typeof search !== "object" || Array.isArray(search)) {
      return new Error(
        "Each entry in `searches` must be an object with a `keywords` field.",
      );
    }
    if (
      !Array.isArray(search.keywords) ||
      search.keywords.length === 0 ||
      search.keywords.some((k) => typeof k !== "string" || k.length === 0)
    ) {
      return new Error(
        "Each search's `keywords` must be a non-empty array of non-empty strings.",
      );
    }
  }
  if (!input.question || typeof input.question !== "string") {
    return new Error("`question` is required and must be a string.");
  }
  return null;
}

/**
 * @param {WebSearchToolCommandOptions} config
 * @param {WebSearchInput} input
 * @returns {Promise<string | Error>}
 */
async function webSearchViaCommand(config, input) {
  const maxLengthPerSearch =
    config.maxLengthPerSearch ?? DEFAULT_MAX_LENGTH_PER_SEARCH;
  const maxTotalLength = config.maxTotalLength ?? DEFAULT_MAX_TOTAL_LENGTH;
  const delayBetweenRequestsMs =
    config.delayBetweenRequestsMs ?? DEFAULT_DELAY_BETWEEN_REQUESTS_MS;

  /** @type {{ keywords: string[], text: string, truncated: boolean, originalLength: number, error?: string }[]} */
  const results = [];
  for (const search of input.searches) {
    if (delayBetweenRequestsMs > 0 && results.length > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, delayBetweenRequestsMs),
      );
    }
    try {
      const raw = await runSearchCommand(config, search.keywords);
      const { text, truncated, originalLength } = truncateText(
        raw,
        maxLengthPerSearch,
      );
      results.push({
        keywords: search.keywords,
        text,
        truncated,
        originalLength,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(styleText("yellow", message));
      results.push({
        keywords: search.keywords,
        text: "",
        truncated: false,
        originalLength: 0,
        error: message,
      });
    }
  }

  const successCount = results.filter((r) => !r.error).length;
  if (successCount === 0) {
    return new Error(
      `Failed to run any search via ${config.command}:\n${results
        .map((r) => `- [${r.keywords.join(" ")}]: ${r.error ?? "unknown"}`)
        .join("\n")}`,
    );
  }

  const sections = results.map((r) => {
    const keywordsAttr = r.keywords.join(" ").replace(/"/g, "'");
    if (r.error) {
      return `<search keywords="${keywordsAttr}" error="${r.error.replace(/"/g, "'")}"></search>`;
    }
    const attrs = r.truncated
      ? ` truncated="true" original_length="${r.originalLength}"`
      : "";
    return `<search keywords="${keywordsAttr}"${attrs}>\n${r.text}\n</search>`;
  });

  const joined = sections.join("\n\n");
  const totalCap = truncateText(joined, maxTotalLength);

  const searchCommandDisplay = [
    config.command,
    ...config.args,
    "<KEYWORDS...>",
  ].join(" ");
  const systemPrompt = [
    "You distil multiple web-search results into entries relevant to the user's question.",
    `Each search's raw output is wrapped in a <search keywords="..."> tag and was produced by \`${searchCommandDisplay}\`.`,
    'Some searches may be marked truncated="true"; treat those as partial.',
    "Discard unrelated entries; keep only what helps answer the question.",
    "Preserve any source URLs from the raw output and cite them inline (e.g., [1], [2]).",
    "If none of the results are relevant, say so explicitly rather than guessing.",
  ].join(" ");

  const userPrompt = [
    `Question: ${input.question}`,
    "",
    "Searches run:",
    ...input.searches.map((s, i) => `- [${i + 1}] ${s.keywords.join(" ")}`),
    "",
    "Search results:",
    totalCap.text,
  ].join("\n");

  const modelResult = await config.modelCaller({
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: systemPrompt }],
      },
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
      },
    ],
  });

  if (modelResult instanceof Error) {
    return modelResult;
  }

  const answerText = modelResult.message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

  const summaryList = results
    .map((r, i) => {
      const suffix = r.error
        ? ` (error: ${r.error})`
        : r.truncated
          ? " (truncated)"
          : "";
      return `- [${i + 1}] ${r.keywords.join(" ")}${suffix}`;
    })
    .join("\n");

  return [answerText, summaryList].join("\n\n");
}

/**
 * @param {WebSearchToolGeminiOptions | WebSearchToolGeminiVertexAIOptions} config
 * @param {WebSearchInput} input
 * @param {number} retryCount
 * @returns {Promise<string | Error>}
 */
async function webSearchViaGemini(config, input, retryCount) {
  const model = config.model ?? "gemini-3.6-flash";
  const url =
    config.provider === "gemini-vertex-ai"
      ? `${config.baseURL}/publishers/google/models/${config.model}:generateContent`
      : config.baseURL
        ? `${config.baseURL}/models/${model}:generateContent`
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  /** @type {Record<string,string>} */
  const authHeader =
    config.provider === "gemini-vertex-ai"
      ? {
          Authorization: `Bearer ${await getGoogleCloudAccessToken(config.account)}`,
        }
      : {
          "x-goog-api-key": config.apiKey ?? "",
        };

  const keywordsHint = input.searches
    .map((s, i) => `- [${i + 1}] ${s.keywords.join(" ")}`)
    .join("\n");

  const data = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `I need a comprehensive answer to this question. Please note that I don't have access to external URLs, so include all relevant facts, data, or explanations directly in your response. Avoid referencing links I can't open.

Suggested search queries (one per line):
${keywordsHint}

Question: ${input.question}`,
          },
        ],
      },
    ],
    tools: [
      {
        google_search: {},
      },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(120 * 1000),
  });

  if (response.status === 429 || response.status >= 500) {
    const interval = Math.min(2 * 2 ** retryCount, 16);
    console.error(
      styleText(
        "yellow",
        `Google API returned ${response.status}. Retrying in ${interval} seconds...`,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    return webSearchViaGemini(config, input, retryCount + 1);
  }

  if (!response.ok) {
    return new Error(
      `Failed to search the web: status=${response.status}, body=${await response.text()}`,
    );
  }

  const body = await response.json();

  const candidate = body.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  /** @type {{segment?:{startIndex:number,endIndex:number,text:string},groundingChunkIndices?:number[]}[] | undefined} */
  const supports = candidate?.groundingMetadata?.groundingSupports;
  /** @type {{web?:{uri:string,title:string}}[] | undefined} */
  const chunks = candidate?.groundingMetadata?.groundingChunks;

  if (typeof text !== "string") {
    return new Error(
      `Unexpected response format from Google: ${JSON.stringify(body)}`,
    );
  }

  // Sort by end_index desc because Gemini grounding indexes are byte offsets
  // into the original UTF-8 text.
  const sortedSupports = supports?.toSorted(
    (a, b) => (b.segment?.endIndex ?? 0) - (a.segment?.endIndex ?? 0),
  );

  // Insert citations using UTF-8 byte offsets.
  let textWithCitations = text;
  for (const support of sortedSupports ?? []) {
    const endIndex = support.segment?.endIndex;
    if (
      typeof endIndex !== "number" ||
      !support.groundingChunkIndices?.length
    ) {
      continue;
    }

    textWithCitations = insertTextAtUtf8ByteIndex(
      textWithCitations,
      endIndex,
      ` [${support.groundingChunkIndices.map((i) => i + 1).join(", ")}] `,
    );
  }

  const chunkString = (chunks ?? [])
    .map(
      (chunk, index) =>
        `- [${index + 1} - ${chunk.web?.title}](${chunk.web?.uri})`,
    )
    .join("\n");

  return [textWithCitations, chunkString].join("\n\n");
}

/**
 * Run `command` with `args` followed by the keywords and return stdout.
 *
 * The process is spawned directly (no shell). When `command` exits with a
 * non-zero status, the resulting error message includes the keywords and any
 * captured stderr to aid diagnosis.
 *
 * @param {WebSearchToolCommandOptions} config
 * @param {string[]} keywords
 * @returns {Promise<string>}
 */
function runSearchCommand(config, keywords) {
  return new Promise((resolve, reject) => {
    execFile(
      config.command,
      [...config.args, ...keywords],
      {
        shell: false,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          ...(config.env ?? {}),
        },
        timeout: config.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
        maxBuffer: SEARCH_MAX_BUFFER_BYTES,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${config.command} failed for [${keywords.join(" ")}]: ${err.message}${stderr ? `\n${stderr}` : ""}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * @param {string} source
 * @param {number} byteIndex
 * @param {string} insertText
 */
function insertTextAtUtf8ByteIndex(source, byteIndex, insertText) {
  const sourceBuffer = Buffer.from(source, "utf8");
  const normalizedByteIndex = Math.max(
    0,
    Math.min(byteIndex, sourceBuffer.length),
  );

  return Buffer.concat([
    sourceBuffer.subarray(0, normalizedByteIndex),
    Buffer.from(insertText, "utf8"),
    sourceBuffer.subarray(normalizedByteIndex),
  ]).toString("utf8");
}
