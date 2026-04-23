/**
 * @import { CostSummary } from "./costTracker.mjs"
 */

import fs from "node:fs/promises";
import path from "node:path";
import { USAGE_LOG_PATH } from "./env.mjs";

/**
 * @typedef {Object} UsageRecord
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string} sessionId
 * @property {"interactive" | "batch"} mode
 * @property {string} modelName - e.g. "claude-sonnet-4-6+thinking-high"
 * @property {string} workingDir
 * @property {string} currency - e.g. "USD"
 * @property {string} unit - e.g. "1M"
 * @property {number | null} totalCost - null when no pricing configured
 * @property {Record<string, number>} tokens - aggregated token counts by path
 */

/**
 * Maximum size (in bytes) of a single JSONL line.
 * Linux guarantees atomicity of O_APPEND writes up to PIPE_BUF (4096 bytes),
 * so we enforce a smaller limit to stay safely under that threshold even
 * with multi-byte UTF-8 characters in model/session names.
 */
const MAX_RECORD_BYTES = 3072;

/**
 * Append a usage record to the persistent usage log.
 *
 * On POSIX systems, `fs.appendFile` opens the file with `O_APPEND`, which
 * guarantees that each write lands at end-of-file and is atomic when the
 * payload is <= PIPE_BUF (4096 bytes on Linux). We write the record as a
 * single call to preserve this guarantee even if multiple plain-agent
 * sessions finish simultaneously.
 *
 * @param {UsageRecord} record
 * @param {{ path?: string }} [options]
 * @returns {Promise<void>}
 */
export async function appendUsageRecord(record, options = {}) {
  const filePath = options.path ?? USAGE_LOG_PATH;
  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_RECORD_BYTES) {
    throw new Error(
      `Usage record exceeds ${MAX_RECORD_BYTES} bytes (${bytes}); refusing to write to keep appends atomic.`,
    );
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, { encoding: "utf8" });
}

/**
 * Read all usage records from the log file.
 * Malformed lines are skipped and collected in `skipped`.
 *
 * @param {{ path?: string }} [options]
 * @returns {Promise<{ records: UsageRecord[], skipped: { line: number, reason: string }[] }>}
 */
export async function readUsageRecords(options = {}) {
  const filePath = options.path ?? USAGE_LOG_PATH;
  /** @type {string} */
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (
      err instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT"
    ) {
      return { records: [], skipped: [] };
    }
    throw err;
  }

  /** @type {UsageRecord[]} */
  const records = [];
  /** @type {{ line: number, reason: string }[]} */
  const skipped = [];

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length === 0) continue;
    try {
      const parsed = JSON.parse(raw);
      if (!isUsageRecord(parsed)) {
        skipped.push({ line: i + 1, reason: "invalid shape" });
        continue;
      }
      records.push(parsed);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ line: i + 1, reason });
    }
  }

  return { records, skipped };
}

/**
 * Build a usage record from a finished session's cost summary.
 * Returns null when there's nothing worth recording (no tokens).
 *
 * @param {Object} args
 * @param {string} args.sessionId
 * @param {"interactive" | "batch"} args.mode
 * @param {string} args.modelName
 * @param {string} args.workingDir
 * @param {CostSummary} args.costSummary
 * @param {Date} [args.now]
 * @returns {UsageRecord | null}
 */
export function buildUsageRecord({
  sessionId,
  mode,
  modelName,
  workingDir,
  costSummary,
  now,
}) {
  /** @type {Record<string, number>} */
  const tokens = {};
  for (const [key, entry] of Object.entries(costSummary.breakdown)) {
    tokens[key] = entry.tokens;
  }
  if (Object.keys(tokens).length === 0) {
    return null;
  }
  const timestamp = (now ?? new Date()).toISOString();
  return {
    timestamp,
    sessionId,
    mode,
    modelName,
    workingDir,
    currency: costSummary.currency,
    unit: costSummary.unit,
    totalCost:
      costSummary.totalCost === undefined ? null : costSummary.totalCost,
    tokens,
  };
}

/**
 * @param {unknown} value
 * @returns {value is UsageRecord}
 */
function isUsageRecord(value) {
  if (typeof value !== "object" || value === null) return false;
  const r = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof r.timestamp === "string" &&
    typeof r.sessionId === "string" &&
    (r.mode === "interactive" || r.mode === "batch") &&
    typeof r.modelName === "string" &&
    typeof r.workingDir === "string" &&
    typeof r.currency === "string" &&
    typeof r.unit === "string" &&
    (r.totalCost === null || typeof r.totalCost === "number") &&
    typeof r.tokens === "object" &&
    r.tokens !== null
  );
}
