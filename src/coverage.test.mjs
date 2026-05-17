/**
 * Smoke test that dynamically discovers and imports every non-test, non-playground
 * .mjs file under src/. This ensures all source files appear in the
 * code-coverage denominator when running with --experimental-test-coverage.
 *
 * Excluded patterns:
 *   - *.test.mjs, *.test.*.mjs  (test files & test helpers)
 *   - *.playground.mjs          (playground / scratch files)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Recursively collect .mjs source files, excluding test/playground.
 * @param {string} dir
 * @param {string[]} files
 */
async function walk(dir, files) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else if (entry.name.endsWith(".mjs")) {
      if (entry.name.includes(".test.")) continue;
      if (entry.name.endsWith(".playground.mjs")) continue;
      files.push(fullPath);
    }
  }
}

/**
 * Recursively collect .mjs source files, excluding test/playground.
 * @returns {Promise<string[]>} Absolute paths sorted for stable output.
 */
async function collectSourceFiles() {
  /** @type {string[]} */
  const files = [];
  await walk(__dirname, files);
  return files.sort();
}

describe("coverage: import all source files", () => {
  it("should dynamically import all .mjs files without error", async () => {
    // given: collect every source file under src/
    const files = await collectSourceFiles();

    // when: import each file
    const results = await Promise.allSettled(files.map((f) => import(f)));

    // then: every import must succeed
    const failures = results
      .map((r, i) => ({ ...r, file: files[i] }))
      .filter((r) => r.status === "rejected");

    if (failures.length > 0) {
      const details = failures
        .map((f) => `  ${path.relative(__dirname, f.file)}: ${f.reason}`)
        .join("\n");
      throw new Error(
        `Failed to import ${failures.length} file(s):\n${details}`,
      );
    }
  });
});
