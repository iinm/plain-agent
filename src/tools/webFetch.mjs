/**
 * @import { Tool } from '../tool'
 * @import { CallModel } from '../model'
 */

import { execFile } from "node:child_process";
import { styleText } from "node:util";
import { getGoogleCloudAccessToken } from "../providers/platform/googleCloud.mjs";
import { noThrow } from "../utils/noThrow.mjs";

/**
 * @typedef {WebFetchToolGeminiOptions
 *   | WebFetchToolGeminiVertexAIOptions
 *   | WebFetchToolCommandOptions} WebFetchToolOptions
 */

/**
 * @typedef {Object} WebFetchToolGeminiOptions
 * @property {"gemini"} provider
 * @property {string=} baseURL
 * @property {string} apiKey
 * @property {string} model
 */

/**
 * @typedef {Object} WebFetchToolGeminiVertexAIOptions
 * @property {"gemini-vertex-ai"} provider
 * @property {string} baseURL
 * @property {string=} account
 * @property {string} model
 */

/**
 * Runtime configuration for the `command` provider.
 *
 * Runs `command` with `args` followed by the URL (one process per call, no
 * shell). `modelCaller` is injected by the caller (e.g., `main.mjs`) using
 * the agent's main model.
 *
 * @typedef {Object} WebFetchToolCommandOptions
 * @property {"command"} provider
 * @property {string} command Executable used to fetch the URL (e.g., `"w3m"`, `"curl"`).
 * @property {string[]} args Arguments passed before the URL (e.g., `["-dump"]`).
 * @property {number=} timeoutMs Per-call timeout in milliseconds (default 30000).
 * @property {Record<string, string>=} env Extra environment variables, merged on top of PATH / HOME / LANG.
 * @property {CallModel} modelCaller
 * @property {number=} maxLength Truncate fetched content to this many characters (default 200000).
 */

/**
 * @typedef {Object} WebFetchInput
 * @property {string} url
 * @property {string} question
 */

/** @type {number} */
const DEFAULT_MAX_LENGTH = 200_000;

/** @type {number} */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** @type {number} */
const FETCH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * @param {WebFetchToolOptions} config
 * @returns {Tool}
 */
export function createWebFetchTool(config) {
  return {
    def: {
      name: "web_fetch",
      description:
        "Fetch the contents of a single URL and answer a question based on it.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The http(s) URL to fetch.",
          },
          question: {
            type: "string",
            description:
              "The question to answer using the fetched URL contents.",
          },
        },
        required: ["url", "question"],
      },
    },

    /**
     * @param {WebFetchInput} input
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
            return webFetchViaGemini(config, input, 0);
          case "command":
            return webFetchViaCommand(config, input);
        }
      }),

    /**
     * Reduce the URL to its origin so that approving one URL on a host
     * effectively approves any path on the same host. Pairs with the
     * in-session matcher applying the mask to both sides.
     *
     * @param {Record<string, unknown>} input
     * @returns {Record<string, unknown>}
     */
    maskApprovalInput: (input) => {
      const webFetchInput = /** @type {Partial<WebFetchInput>} */ (input);
      const origin = extractOrigin(webFetchInput.url);
      return { url: origin };
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
 * Return the URL's origin (`<scheme>//<host>`) when parseable, otherwise an
 * empty string. Used so per-domain auto-approval works regardless of path.
 *
 * @param {unknown} url
 * @returns {string}
 */
export function extractOrigin(url) {
  if (typeof url !== "string") {
    return "";
  }
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "";
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/**
 * @param {WebFetchInput} input
 * @returns {Error | null}
 */
function validateInput(input) {
  if (!input.url || typeof input.url !== "string") {
    return new Error("`url` is required and must be a string.");
  }
  if (!/^https?:\/\//.test(input.url)) {
    return new Error(
      `Invalid URL: \`${input.url}\` must start with http(s)://`,
    );
  }
  if (!input.question || typeof input.question !== "string") {
    return new Error("`question` is required and must be a string.");
  }
  return null;
}

/**
 * @param {WebFetchToolCommandOptions} config
 * @param {WebFetchInput} input
 * @returns {Promise<string | Error>}
 */
async function webFetchViaCommand(config, input) {
  const maxLength = config.maxLength ?? DEFAULT_MAX_LENGTH;

  /** @type {string} */
  let raw;
  try {
    raw = await runFetchCommand(config, input.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(styleText("yellow", message));
    return new Error(message);
  }

  const { text, truncated, originalLength } = truncateText(raw, maxLength);

  const fetchCommandDisplay = [config.command, ...config.args, "<URL>"].join(
    " ",
  );
  const systemPrompt = [
    "You answer the user's question based solely on the provided URL contents.",
    `The content is wrapped in a <url href="..."> tag and was fetched with \`${fetchCommandDisplay}\`.`,
    'If the page is marked truncated="true", treat it as partial.',
    "Cite the source URL inline (e.g., [1]) and list it at the end.",
    "If the contents do not answer the question, say so explicitly rather than guessing.",
  ].join(" ");

  const attrs = truncated
    ? ` truncated="true" original_length="${originalLength}"`
    : "";
  const userPrompt = [
    `Question: ${input.question}`,
    "",
    "URL content:",
    `<url href="${input.url}"${attrs}>`,
    text,
    "</url>",
  ].join("\n");

  const userPromptResult = await config.modelCaller({
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

  if (userPromptResult instanceof Error) {
    return userPromptResult;
  }

  const answerText = userPromptResult.message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

  const suffix = truncated ? " (truncated)" : "";
  const sourcesList = `- [1] ${input.url}${suffix}`;

  return [answerText, sourcesList].join("\n\n");
}

/**
 * @param {WebFetchToolGeminiOptions | WebFetchToolGeminiVertexAIOptions} config
 * @param {WebFetchInput} input
 * @param {number} retryCount
 * @returns {Promise<string | Error>}
 */
async function webFetchViaGemini(config, input, retryCount) {
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

URL: ${input.url}
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
    return webFetchViaGemini(config, input, retryCount + 1);
  }

  if (!response.ok) {
    return new Error(
      `Failed to fetch URL: status=${response.status}, body=${await response.text()}`,
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
 * Run `command` with `args` followed by `url` and return stdout.
 *
 * The process is spawned directly (no shell). When `command` exits with a
 * non-zero status, the resulting error message includes the URL and any
 * captured stderr to aid diagnosis.
 *
 * @param {WebFetchToolCommandOptions} config
 * @param {string} url
 * @returns {Promise<string>}
 */
function runFetchCommand(config, url) {
  return new Promise((resolve, reject) => {
    execFile(
      config.command,
      [...config.args, url],
      {
        shell: false,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          ...(config.env ?? {}),
        },
        timeout: config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        maxBuffer: FETCH_MAX_BUFFER_BYTES,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${config.command} failed for ${url}: ${err.message}${stderr ? `\n${stderr}` : ""}`,
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
