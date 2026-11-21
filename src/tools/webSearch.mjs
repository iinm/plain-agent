/**
 * Public entry point for the `web_search` tool. Provider implementations live
 * in `webSearch/`; this file owns input validation, dispatch, and the public
 * type surface.
 *
 * @import { Tool } from '../tool'
 * @import { WebSearchInput } from './webSearch/types.mjs'
 * @import { WebSearchToolCommandOptions } from './webSearch/command.mjs'
 * @import {
 *   WebSearchToolGeminiOptions,
 *   WebSearchToolGeminiVertexAIOptions,
 * } from './webSearch/gemini.mjs'
 * @import {
 *   WebSearchToolAgentCoreFilters,
 *   WebSearchToolAgentCoreJsonOptions,
 *   WebSearchToolAgentCoreOptions,
 * } from './webSearch/agentcore.mjs'
 */

/**
 * @typedef {WebSearchToolGeminiOptions
 *   | WebSearchToolGeminiVertexAIOptions
 *   | WebSearchToolAgentCoreOptions
 *   | WebSearchToolCommandOptions} WebSearchToolOptions
 */

import { noThrow } from "../utils/noThrow.mjs";
import { webSearchViaAgentCore } from "./webSearch/agentcore.mjs";
import { webSearchViaCommand } from "./webSearch/command.mjs";
import { webSearchViaGemini } from "./webSearch/gemini.mjs";

/**
 * Re-exported so that shared typedefs (`WebSearchInput`, `SearchSource`) stay
 * importable from this entry point.
 */
export * from "./webSearch/types.mjs";

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
          case "bedrock-agentcore":
            return webSearchViaAgentCore(config, input);
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
 * @param {WebSearchInput} input
 * @returns {Error | undefined}
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
  return undefined;
}
