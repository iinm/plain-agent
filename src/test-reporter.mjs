/**
 * Minimal test reporter – shows only failures and a final summary.
 * Usage: node --test --test-reporter=./src/test-reporter.mjs
 */
/** @param {AsyncIterable<{type: string, data: {nesting?: number, details?: {type?: string, error?: {message?: string, expected?: unknown, actual?: unknown}}, name?: string, file?: string}}>} source */
export default async function* reporter(source) {
  let passed = 0;
  let failed = 0;
  const startMs = Date.now();
  /** @type {{name?: string, file?: string, details?: {error?: {message?: string, expected?: unknown, actual?: unknown}}}[]} */
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
      const err = f.details?.error;
      if (err) {
        if (err.message) yield `  ${err.message}\n`;
        if (err.expected !== undefined && err.actual !== undefined) {
          yield `  expected: ${JSON.stringify(err.expected)}\n`;
          yield `  actual:   ${JSON.stringify(err.actual)}\n`;
        }
      }
      yield "\n";
    }
  }

  const total = passed + failed;
  const status = failed > 0 ? "FAIL" : "PASS";
  yield `${status} - ${total} tests (${passed} passed, ${failed} failed) in ${durationMs}ms\n`;
}
