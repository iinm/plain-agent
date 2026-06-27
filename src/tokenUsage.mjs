/**
 * @import { ProviderTokenUsage } from "./model"
 */

/**
 * Candidate keys for extracting "current context size" (input/prompt token count)
 * from a provider's token usage object. Ordered by priority — the first match wins.
 */
const INPUT_TOKEN_KEYS = [
  "input_tokens",
  "inputTokens",
  "promptTokenCount",
  "prompt_tokens",
  "totalTokenCount",
  "totalTokens",
];

/**
 * Extract the input (prompt/context) token count from a single turn's
 * provider token usage object. Returns `undefined` when no recognizable
 * key is found or the value is not a positive number.
 *
 * @param {ProviderTokenUsage} usage
 * @returns {number | undefined}
 */
export function extractInputTokenCount(usage) {
  for (const key of INPUT_TOKEN_KEYS) {
    const value = usage[key];
    if (typeof value === "number" && value > 0) {
      return value;
    }
  }

  // Some providers nest usage inside a sub-object (e.g., bedrock's `usage`).
  for (const value of Object.values(usage)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const key of INPUT_TOKEN_KEYS) {
        const nested = /** @type {Record<string, unknown>} */ (value)[key];
        if (typeof nested === "number" && nested > 0) {
          return nested;
        }
      }
    }
  }

  return undefined;
}
