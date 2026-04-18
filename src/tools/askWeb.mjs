/**
 * @import { Tool } from '../tool'
 */

import { styleText } from "node:util";
import { getGoogleCloudAccessToken } from "../providers/platform/googleCloud.mjs";
import { abortableSleep } from "../utils/abortSignal.mjs";
import { noThrow } from "../utils/noThrow.mjs";

/** @typedef {AskWebToolGeminiOptions | AskWebToolGeminiVertexAIOptions} AskWebToolOptions */

/**
 * @typedef {Object} AskWebToolGeminiOptions
 * @property {"gemini"} provider
 * @property {string=} baseURL
 * @property {string} apiKey
 * @property {string} model
 */

/**
 * @typedef {Object} AskWebToolGeminiVertexAIOptions
 * @property {"gemini-vertex-ai"} provider
 * @property {string} baseURL
 * @property {string=} account
 * @property {string} model
 */

/**
 * @typedef {Object} AskWebInput
 * @property {string} question
 */

/**
 * @param {AskWebToolOptions} config
 * @returns {Tool}
 */
export function createAskWebTool(config) {
  /**
   * @param {AskWebInput} input
   * @param {number} retryCount
   * @param {AbortSignal} [signal]
   * @returns {Promise<string | Error>}
   */
  async function askWeb(input, retryCount, signal) {
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
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(120 * 1000), signal])
        : AbortSignal.timeout(120 * 1000),
    });

    if (response.status === 429 || response.status >= 500) {
      const interval = Math.min(2 * 2 ** retryCount, 16);
      console.error(
        styleText(
          "yellow",
          `Google API returned ${response.status}. Retrying in ${interval} seconds...`,
        ),
      );
      await abortableSleep(interval * 1000, signal);
      return askWeb(input, retryCount + 1, signal);
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

    /**
     * @param {string} source
     * @param {number} byteIndex
     * @param {string} insertText
     */
    const insertTextAtUtf8ByteIndex = (source, byteIndex, insertText) => {
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
    };

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

  return {
    def: {
      name: "ask_web",
      description:
        "Use the web search to answer questions that need up-to-date information or supporting sources.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask",
          },
        },
        required: ["question"],
      },
    },

    /**
     * @param {AskWebInput} input
     * @returns {Promise<string | Error>}
     */
    impl: async (input, options) =>
      await noThrow(async () => askWeb(input, 0, options?.signal)),

    /**
     * @param {Record<string, unknown>} _input
     * @returns {Record<string, unknown>}
     */
    maskApprovalInput: (_input) => {
      return {};
    },
  };
}
