/**
 * @import { Tool } from '../tool'
 * @import { CallModel } from '../model'
 */

import { execFile } from "node:child_process";
import { styleText } from "node:util";
import { getGoogleCloudAccessToken } from "../providers/platform/googleCloud.mjs";
import { noThrow } from "../utils/noThrow.mjs";

/**
 * @typedef {AskURLToolGeminiOptions
 *   | AskURLToolGeminiVertexAIOptions
 *   | AskURLToolBuiltinW3MOptions} AskURLToolOptions
 */

/**
 * @typedef {Object} AskURLToolGeminiOptions
 * @property {"gemini"} provider
 * @property {string=} baseURL
 * @property {string} apiKey
 * @property {string} model
 */

/**
 * @typedef {Object} AskURLToolGeminiVertexAIOptions
 * @property {"gemini-vertex-ai"} provider
 * @property {string} baseURL
 * @property {string=} account
 * @property {string} model
 */

/**
 * Runtime configuration for the `builtin+w3m` provider.
 *
 * `modelCaller` is injected by the caller (e.g., `main.mjs`) using the agent's
 * main model.
 *
 * @typedef {Object} AskURLToolBuiltinW3MOptions
 * @property {"builtin+w3m"} provider
 * @property {CallModel} modelCaller
 * @property {number=} maxLengthPerURL Truncate each URL's dumped content to this many characters (default 200000).
 * @property {number=} maxTotalLength Truncate the combined content across all URLs to this many characters (default 400000).
 */

/**
 * @typedef {Object} AskURLInput
 * @property {string} question
 */

/** @type {number} */
const DEFAULT_MAX_LENGTH_PER_URL = 200_000;

/** @type {number} */
const DEFAULT_MAX_TOTAL_LENGTH = 400_000;

/** @type {number} */
const W3M_TIMEOUT_MS = 30_000;

/**
 * @param {AskURLToolOptions} config
 * @returns {Tool}
 */
export function createAskURLTool(config) {
  return {
    def: {
      name: "ask_url",
      description:
        "Use one or more provided URLs to answer a question. Include the URLs in your question.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question to ask, including one or more URLs to use as context.",
          },
        },
        required: ["question"],
      },
    },

    /**
     * @param {AskURLInput} input
     * @returns {Promise<string | Error>}
     */
    impl: async (input) =>
      await noThrow(async () => {
        switch (config.provider) {
          case "gemini":
          case "gemini-vertex-ai":
            return askURLViaGemini(config, input, 0);
          case "builtin+w3m":
            return askURLViaBuiltinW3M(config, input);
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
 * Extract http(s) URLs from `text`.
 *
 * Each URL is delimited by whitespace; the caller (typically an LLM) is
 * expected to separate URLs from surrounding prose with spaces.
 * Duplicates are removed while preserving the first-seen order.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractURLs(text) {
  const matches = text.match(/https?:\/\/\S+/g) ?? [];
  /** @type {string[]} */
  const urls = [];
  const seen = new Set();
  for (const url of matches) {
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
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
 * Run `w3m -dump <url>` and return stdout.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
function w3mDump(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "w3m",
      ["-dump", url],
      {
        shell: false,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
        },
        timeout: W3M_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `w3m failed for ${url}: ${err.message}${stderr ? `\n${stderr}` : ""}`,
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
 * @param {AskURLToolBuiltinW3MOptions} config
 * @param {AskURLInput} input
 * @returns {Promise<string | Error>}
 */
async function askURLViaBuiltinW3M(config, input) {
  const urls = extractURLs(input.question);
  if (urls.length === 0) {
    return new Error(
      "No http(s) URLs were found in the question. Include at least one URL in your question.",
    );
  }

  const maxLengthPerURL = config.maxLengthPerURL ?? DEFAULT_MAX_LENGTH_PER_URL;
  const maxTotalLength = config.maxTotalLength ?? DEFAULT_MAX_TOTAL_LENGTH;

  /** @type {{ url: string, text: string, truncated: boolean, originalLength: number, error?: string }[]} */
  const dumped = [];
  for (const url of urls) {
    try {
      const raw = await w3mDump(url);
      const { text, truncated, originalLength } = truncateText(
        raw,
        maxLengthPerURL,
      );
      dumped.push({ url, text, truncated, originalLength });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(styleText("yellow", message));
      dumped.push({
        url,
        text: "",
        truncated: false,
        originalLength: 0,
        error: message,
      });
    }
  }

  const successCount = dumped.filter((d) => !d.error).length;
  if (successCount === 0) {
    return new Error(
      `Failed to fetch any URL via w3m:\n${dumped
        .map((d) => `- ${d.url}: ${d.error ?? "unknown"}`)
        .join("\n")}`,
    );
  }

  const contentSections = dumped.map((d) => {
    if (d.error) {
      return `<url href="${d.url}" error="${d.error.replace(/"/g, "'")}"></url>`;
    }
    const attrs = d.truncated
      ? ` truncated="true" original_length="${d.originalLength}"`
      : "";
    return `<url href="${d.url}"${attrs}>\n${d.text}\n</url>`;
  });

  // Apply a total cap by truncating the joined content as a whole. This is a
  // backstop in case many URLs are passed; per-URL truncation already handles
  // the common case.
  const joined = contentSections.join("\n\n");
  const totalCap = truncateText(joined, maxTotalLength);

  const systemPrompt = [
    "You answer the user's question based solely on the provided URL contents.",
    'Each URL\'s content is wrapped in an <url href="..."> tag and was extracted with `w3m -dump`.',
    'Some pages may be marked truncated="true"; treat those as partial.',
    "Cite the source URL inline (e.g., [1], [2]) and list the URLs at the end.",
    "If the contents do not answer the question, say so explicitly rather than guessing.",
  ].join(" ");

  const userPrompt = [
    `Question: ${input.question}`,
    "",
    "URL contents:",
    totalCap.text,
  ].join("\n");

  const result = await config.modelCaller({
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

  if (result instanceof Error) {
    return result;
  }

  const answerText = result.message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

  const sourcesList = dumped
    .map((d, i) => {
      const suffix = d.error
        ? ` (error: ${d.error})`
        : d.truncated
          ? " (truncated)"
          : "";
      return `- [${i + 1}] ${d.url}${suffix}`;
    })
    .join("\n");

  return [answerText, sourcesList].join("\n\n");
}

/**
 * @param {AskURLToolGeminiOptions | AskURLToolGeminiVertexAIOptions} config
 * @param {AskURLInput} input
 * @param {number} retryCount
 * @returns {Promise<string | Error>}
 */
async function askURLViaGemini(config, input, retryCount) {
  const model = config.model ?? "gemini-3-flash-preview";
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

  const data = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `I need a comprehensive answer to this question. Please note that I don't have access to external URLs, so include all relevant facts, data, or explanations directly in your response. Avoid referencing links I can't open.

Question: ${input.question}`,
          },
        ],
      },
    ],
    tools: [
      {
        url_context: {},
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
    return askURLViaGemini(config, input, retryCount + 1);
  }

  if (!response.ok) {
    return new Error(
      `Failed to ask Web: status=${response.status}, body=${await response.text()}`,
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
