/**
 * @import { ProviderTokenUsage } from "./model"
 */

/**
 * @typedef {Object} TokenBreakdown
 * @property {number} tokens - Token count
 * @property {number | undefined} cost - Cost (undefined if no pricing)
 */

/**
 * @typedef {Object} CostSummary
 * @property {string} currency - Currency code (e.g., "USD")
 * @property {string} unit - Unit size (e.g., "1M")
 * @property {Record<string, TokenBreakdown>} breakdown - Token breakdown
 * @property {number | undefined} totalCost - Total cost (undefined if no pricing)
 */

/**
 * @typedef {Object} CostConfig
 * @property {string} currency
 * @property {string} unit
 * @property {Record<string, number>} costs
 */

/**
 * @typedef {Object} CostTracker
 * @property {(usage: ProviderTokenUsage) => void} recordUsage - Record token usage
 * @property {() => Record<string, number>} getAggregatedUsage - Get aggregated usage
 * @property {() => CostSummary} calculateCost - Calculate cost summary
 * @property {() => boolean} hasUsage - Check if any usage recorded
 */

/**
 * Validate a cost configuration object at runtime.
 * @param {unknown} config
 */
function validateCostConfig(config) {
  if (config === undefined) return;
  if (typeof config !== "object" || config === null) {
    throw new TypeError("CostConfig must be an object");
  }
  const c = /** @type {Record<string, unknown>} */ (config);
  if (typeof c.currency !== "string") {
    throw new TypeError("CostConfig.currency must be a string");
  }
  if (typeof c.unit !== "string") {
    throw new TypeError("CostConfig.unit must be a string");
  }
  if (typeof c.costs !== "object" || c.costs === null) {
    throw new TypeError("CostConfig.costs must be an object");
  }
  for (const [key, value] of Object.entries(
    /** @type {Record<string, unknown>} */ (c.costs),
  )) {
    if (typeof value !== "number") {
      throw new TypeError(
        `CostConfig.costs["${key}"] must be a number, got ${typeof value}`,
      );
    }
  }
}

/**
 * Create a cost tracker for session token usage
 * @param {CostConfig} [costConfig] - Optional cost configuration
 * @returns {CostTracker}
 */
export function createCostTracker(costConfig) {
  validateCostConfig(costConfig);

  /** @type {ProviderTokenUsage[]} */
  const usageHistory = [];

  /**
   * Record token usage from a provider.
   * Throws when usage is not a non-null object.
   * @param {ProviderTokenUsage} usage
   * @throws {TypeError} when usage is null, undefined, or not an object
   */
  function recordUsage(usage) {
    if (typeof usage !== "object" || usage === null) {
      throw new TypeError("usage must be a non-null object");
    }
    usageHistory.push(usage);
  }

  /**
   * Get aggregated token usage
   * @returns {Record<string, number>}
   */
  function getAggregatedUsage() {
    return aggregateTokens(usageHistory);
  }

  /**
   * Calculate cost summary
   * @returns {CostSummary}
   */
  function calculateCost() {
    const aggregated = aggregateTokens(usageHistory);
    return calculateCostFromConfig(aggregated, costConfig);
  }

  /**
   * Check if any usage recorded
   * @returns {boolean}
   */
  function hasUsage() {
    return usageHistory.length > 0;
  }

  return Object.freeze({
    recordUsage,
    getAggregatedUsage,
    calculateCost,
    hasUsage,
  });
}

/**
 * Aggregate token usage history by key
 * @param {ProviderTokenUsage[]} usageHistory
 * @returns {Record<string, number>}
 */
function aggregateTokens(usageHistory) {
  /** @type {Record<string, number>} */
  const aggregated = {};

  for (const usage of usageHistory) {
    recursivelySumValues(usage, [], aggregated);
  }

  return aggregated;
}

/**
 * Recursively sum numeric values in token usage
 * @param {ProviderTokenUsage} obj
 * @param {string[]} path
 * @param {Record<string, number>} result
 */
function recursivelySumValues(obj, path, result) {
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = [...path, key];
    const pathStr = currentPath.join(".");

    if (typeof value === "number") {
      result[pathStr] = (result[pathStr] || 0) + value;
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      recursivelySumValues(value, currentPath, result);
    }
  }
}

/**
 * Calculate cost from aggregated tokens and config
 * @param {Record<string, number>} aggregated
 * @param {CostConfig | undefined} config
 * @returns {CostSummary}
 */
function calculateCostFromConfig(aggregated, config) {
  /** @type {Record<string, TokenBreakdown>} */
  const breakdown = {};
  let totalCost = 0;

  for (const [key, tokens] of Object.entries(aggregated)) {
    breakdown[key] = Object.freeze({ tokens, cost: undefined });

    if (!config?.costs?.[key]) {
      continue;
    }

    const costValue = config.costs[key];
    const unitSize = parseUnit(config.unit);

    if (typeof costValue !== "number") {
      throw new TypeError(
        `config.costs["${key}"] must be a number, got ${typeof costValue}`,
      );
    }

    const cost = (tokens * costValue) / unitSize;
    breakdown[key] = Object.freeze({ tokens, cost });
    totalCost += cost;
  }

  return Object.freeze({
    currency: config?.currency ?? "USD",
    unit: config?.unit ?? "1M",
    breakdown,
    totalCost: config?.costs ? totalCost : undefined,
  });
}

/**
 * Parse unit string to number.
 * @param {string} unit
 * @returns {number}
 * @throws {Error} when the unit is not recognized
 */
function parseUnit(unit) {
  if (unit === "1M") return 1_000_000;
  if (unit === "1K") return 1_000;
  throw new Error(`Unknown cost unit: "${unit}"`);
}
