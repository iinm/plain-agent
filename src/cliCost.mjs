/**
 * @import { UsageRecord } from "./usageStore.mjs"
 */

import { styleText } from "node:util";
import { readUsageRecords } from "./usageStore.mjs";

/**
 * @typedef {Object} CostPeriod
 * @property {string} from - YYYY-MM-DD (inclusive, local date)
 * @property {string} to - YYYY-MM-DD (inclusive, local date)
 */

/**
 * @typedef {Object} DailyEntry
 * @property {string} date - YYYY-MM-DD
 * @property {number} totalCost
 * @property {number} sessionCount
 */

/**
 * @typedef {Object} CurrencyAggregation
 * @property {string} currency
 * @property {DailyEntry[]} daily - sorted by date ascending
 * @property {number} totalCost
 * @property {number} sessionCount
 */

/**
 * @typedef {Object} CostReport
 * @property {CostPeriod} period
 * @property {CurrencyAggregation[]} byCurrency - sorted by currency
 * @property {number} noPricingSessionCount - sessions without cost data
 * @property {number} excludedOutOfRange - records dropped (out of period)
 * @property {number} totalRecords - records considered (before filtering)
 */

/**
 * Compute the default period: first day of current month (local) through today (local).
 * @param {Date} [now]
 * @returns {CostPeriod}
 */
export function defaultPeriod(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const firstOfMonth = new Date(y, m, 1);
  return {
    from: formatLocalDate(firstOfMonth),
    to: formatLocalDate(now),
  };
}

/**
 * Format a Date as YYYY-MM-DD in local time.
 * @param {Date} date
 * @returns {string}
 */
export function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Parse and validate a YYYY-MM-DD string, returning a Date at local midnight.
 * @param {string} value
 * @returns {Date}
 */
export function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid date: "${value}" (expected YYYY-MM-DD)`);
  }
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`Invalid date: "${value}"`);
  }
  return date;
}

/**
 * Aggregate usage records into a cost report.
 *
 * @param {UsageRecord[]} records
 * @param {CostPeriod} period
 * @returns {CostReport}
 */
export function aggregateUsage(records, period) {
  const fromDate = parseDateOnly(period.from);
  const toDate = parseDateOnly(period.to);
  if (fromDate.getTime() > toDate.getTime()) {
    throw new Error(
      `"from" (${period.from}) must be on or before "to" (${period.to}).`,
    );
  }

  /** @type {Map<string, Map<string, DailyEntry>>} */
  const byCurrency = new Map();
  let noPricingSessionCount = 0;
  let excludedOutOfRange = 0;

  for (const record of records) {
    const recordedAt = new Date(record.timestamp);
    if (Number.isNaN(recordedAt.getTime())) {
      excludedOutOfRange++;
      continue;
    }
    const localDate = formatLocalDate(recordedAt);
    if (localDate < period.from || localDate > period.to) {
      excludedOutOfRange++;
      continue;
    }
    if (record.totalCost === null) {
      noPricingSessionCount++;
      continue;
    }

    let perDate = byCurrency.get(record.currency);
    if (!perDate) {
      perDate = new Map();
      byCurrency.set(record.currency, perDate);
    }
    const existing = perDate.get(localDate);
    if (existing) {
      existing.totalCost += record.totalCost;
      existing.sessionCount += 1;
    } else {
      perDate.set(localDate, {
        date: localDate,
        totalCost: record.totalCost,
        sessionCount: 1,
      });
    }
  }

  /** @type {CurrencyAggregation[]} */
  const aggregations = [];
  for (const [currency, perDate] of byCurrency) {
    const daily = Array.from(perDate.values()).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );
    const totalCost = daily.reduce((sum, entry) => sum + entry.totalCost, 0);
    const sessionCount = daily.reduce(
      (sum, entry) => sum + entry.sessionCount,
      0,
    );
    aggregations.push({ currency, daily, totalCost, sessionCount });
  }
  aggregations.sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    period,
    byCurrency: aggregations,
    noPricingSessionCount,
    excludedOutOfRange,
    totalRecords: records.length,
  };
}

/**
 * Render a cost report as a human-readable string.
 *
 * @param {CostReport} report
 * @param {{ color?: boolean }} [options]
 * @returns {string}
 */
export function formatCostReport(report, options = {}) {
  const color = options.color ?? true;
  const style = color
    ? styleText
    : /** @param {any} _modifiers @param {string} text */ (_modifiers, text) =>
        text;

  const lines = [];
  lines.push(
    style("bold", `Period: ${report.period.from} to ${report.period.to}`),
  );

  if (report.byCurrency.length === 0) {
    lines.push("");
    lines.push(style("gray", "No usage recorded in this period."));
    if (report.noPricingSessionCount > 0) {
      lines.push(
        style(
          "gray",
          `(${report.noPricingSessionCount} session(s) had no pricing configuration)`,
        ),
      );
    }
    return lines.join("\n");
  }

  for (const agg of report.byCurrency) {
    lines.push("");
    lines.push(style("bold", `Daily cost (${agg.currency}):`));
    for (const entry of agg.daily) {
      lines.push(
        `  ${entry.date}   ${formatCost(entry.totalCost)} ${agg.currency}   (${entry.sessionCount} session${entry.sessionCount === 1 ? "" : "s"})`,
      );
    }
    lines.push("");
    lines.push(
      style(
        "bold",
        `Total: ${formatCost(agg.totalCost)} ${agg.currency} (${agg.sessionCount} session${agg.sessionCount === 1 ? "" : "s"})`,
      ),
    );
  }

  if (report.noPricingSessionCount > 0) {
    lines.push("");
    lines.push(
      style(
        "gray",
        `Note: ${report.noPricingSessionCount} session(s) had no pricing configuration and are excluded from totals.`,
      ),
    );
  }

  return lines.join("\n");
}

/**
 * Format a cost value with 4 decimals.
 * @param {number} value
 * @returns {string}
 */
function formatCost(value) {
  return value.toFixed(4);
}

/**
 * Run the `plain cost` subcommand.
 *
 * @param {{ from: string | null, to: string | null }} args
 * @returns {Promise<number>} exit code
 */
export async function runCostCommand(args) {
  const { from, to } = resolvePeriod(args);

  const { records, skipped } = await readUsageRecords();
  if (skipped.length > 0) {
    console.error(
      `Warning: skipped ${skipped.length} malformed line(s) in usage log.`,
    );
  }

  const report = aggregateUsage(records, { from, to });
  console.log(formatCostReport(report));
  return 0;
}

/**
 * @param {{ from: string | null, to: string | null }} args
 * @returns {CostPeriod}
 */
function resolvePeriod(args) {
  const fallback = defaultPeriod();
  const from = args.from ?? fallback.from;
  const to = args.to ?? fallback.to;
  // Validate format (throws on invalid input).
  parseDateOnly(from);
  parseDateOnly(to);
  return { from, to };
}
