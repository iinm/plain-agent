/**
 * Minimal test reporter – shows only failures and a final summary.
 * Usage: node --test --test-reporter=./src/test-reporter.mjs
 */
import { diffLines } from "./utils/diffLines.mjs";

/**
 * @param {string} expected
 * @param {string} actual
 * @returns {string}
 */
function formatDiff(expected, actual) {
  const ops = diffLines(expected.split("\n"), actual.split("\n"));
  const lines = [];
  for (const op of ops) {
    if (op.type === " ") lines.push(`  ${op.line}`);
    else if (op.type === "-") lines.push(`- ${op.line}`);
    else lines.push(`+ ${op.line}`);
  }
  return lines.join("\n");
}

/**
 * @typedef {{message?: string, cause?: {expected?: unknown, actual?: unknown, message?: string}}} TestError
 * @typedef {{nesting?: number, details?: {type?: string, error?: TestError}, name?: string, file?: string}} TestData
 */

/** @param {AsyncIterable<{type: string, data: TestData}>} source */
export default async function* reporter(source) {
  let passed = 0;
  let failed = 0;
  const startMs = Date.now();
  /** @type {TestData[]} */
  const failures = [];

  for await (const event of source) {
    const isSuite = event.data.details?.type === "suite";
    switch (event.type) {
      case "test:pass":
        if (isSuite) break;
        passed++;
        break;
      case "test:fail":
        if (isSuite) break;
        failed++;
        failures.push(event.data);
        break;
    }
  }

  const durationMs = Date.now() - startMs;

  if (failures.length > 0) {
    yield "\n";
    for (const f of failures) {
      const name = f.name;
      const file = f.file ? ` (${f.file})` : "";
      yield `FAIL: ${name}${file}\n`;
      const cause = f.details?.error?.cause;
      if (
        cause &&
        typeof cause.expected === "string" &&
        typeof cause.actual === "string" &&
        (cause.expected.includes("\n") || cause.actual.includes("\n"))
      ) {
        yield `${formatDiff(cause.expected, cause.actual)}\n`;
      } else if (
        cause &&
        cause.expected !== undefined &&
        cause.actual !== undefined
      ) {
        yield `  expected: ${JSON.stringify(cause.expected)}\n`;
        yield `  actual:   ${JSON.stringify(cause.actual)}\n`;
      } else if (cause?.message) {
        yield `  ${cause.message}\n`;
      } else if (f.details?.error?.message) {
        yield `  ${f.details.error.message}\n`;
      }
      yield "\n";
    }
  }

  const total = passed + failed;
  const status = failed > 0 ? "FAIL" : "PASS";
  yield `${status} - ${total} tests (${passed} passed, ${failed} failed) in ${durationMs}ms\n`;
}
