/**
 * @import { WebSearchInput } from './types.mjs'
 */

import { styleText } from "node:util";
import { getGoogleCloudAccessToken } from "../../providers/platform/googleCloud.mjs";
import {
  MAX_RETRIES,
  normalizeCitationMarkers,
  renderSources,
  selectCitedSources,
} from "./answer.mjs";

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

/** @type {string} */
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** @type {number} */
const GEMINI_TIMEOUT_MS = 120_000;

/**
 * @param {WebSearchToolGeminiOptions | WebSearchToolGeminiVertexAIOptions} config
 * @param {WebSearchInput} input
 * @param {number} retryCount
 * @returns {Promise<string | Error>}
 */
export async function webSearchViaGemini(config, input, retryCount) {
  const model = config.model ?? DEFAULT_GEMINI_MODEL;
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
    .map((s, i) => `- ${i + 1}. ${s.keywords.join(" ")}`)
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
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });

  if (response.status === 429 || response.status >= 500) {
    if (retryCount >= MAX_RETRIES) {
      return new Error(
        `Google API failed after ${retryCount + 1} attempts: status=${response.status}, body=${await response.text()}`,
      );
    }
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

  // All searches share one request, so their sources cannot be attributed to a
  // single search. They are keyed under search 1 to keep the key format uniform.
  /** @type {(chunkIndex: number) => string} */
  const sourceKey = (chunkIndex) => `1.${chunkIndex + 1}`;
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
      ` [[${support.groundingChunkIndices.map(sourceKey).join(", ")}]] `,
    );
  }

  const sources = (chunks ?? []).flatMap((chunk, index) =>
    chunk.web?.uri === undefined
      ? []
      : [{ key: sourceKey(index), url: chunk.web.uri, title: chunk.web.title }],
  );
  const citedSources = selectCitedSources(textWithCitations, sources);

  const summaryList = input.searches
    .map((s, i) => `- [search ${i + 1}] ${s.keywords.join(" ")}`)
    .join("\n");

  return [
    normalizeCitationMarkers(textWithCitations).trim(),
    renderSources(citedSources),
    summaryList,
  ]
    .filter((section) => section !== undefined)
    .join("\n\n");
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
