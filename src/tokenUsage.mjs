/**
 * @import { ProviderTokenUsage } from "./model"
 */

/**
 * Extract the input (prompt/context) token count from a single turn's
 * provider token usage object by summing the values of the specified keys.
 *
 * Returns `undefined` when no specified key yields a positive number.
 *
 * @param {ProviderTokenUsage} usage
 * @param {string[]} inputTokensKeys - Keys whose numeric values are summed.
 * @returns {number | undefined}
 */
export function extractInputTokenCount(usage, inputTokensKeys) {
  let total = 0;
  let found = false;

  for (const key of inputTokensKeys) {
    const value = usage[key];
    if (typeof value === "number" && value > 0) {
      total += value;
      found = true;
    }
  }

  return found ? total : undefined;
}
