import assert from "node:assert";
import { describe, it } from "node:test";
import { createTableDetector } from "./tableDetector.mjs";

/**
 * Helper: feed multiple chunks and collect all output/warnings.
 * @param {string[]} chunks
 * @param {(lines: string[]) => string} [formatTable]
 * @returns {{ output: string, warnings: string[] }}
 */
function feedAll(chunks, formatTable) {
  const detector = createTableDetector(formatTable);
  const allOutput = [];
  const allWarnings = [];
  for (const chunk of chunks) {
    const { output, warnings } = detector.feed(chunk);
    allOutput.push(...output);
    allWarnings.push(...warnings);
  }
  return { output: allOutput.join(""), warnings: allWarnings };
}

/**
 * Helper: feed chunks then forceFlush and collect all output/warnings.
 * @param {string[]} chunks
 * @param {(lines: string[]) => string} [formatTable]
 * @returns {{ output: string, warnings: string[] }}
 */
function feedAllAndFlush(chunks, formatTable) {
  const detector = createTableDetector(formatTable);
  const allOutput = [];
  const allWarnings = [];
  for (const chunk of chunks) {
    const { output, warnings } = detector.feed(chunk);
    allOutput.push(...output);
    allWarnings.push(...warnings);
  }
  const { output, warnings } = detector.forceFlush();
  allOutput.push(...output);
  allWarnings.push(...warnings);
  return { output: allOutput.join(""), warnings: allWarnings };
}

/**
 * Helper: a formatTable function that always throws, for error-path testing.
 * @param {string[]} _lines
 * @returns {string}
 */
function throwingFormatter(_lines) {
  throw new Error("format error for testing");
}

describe("createTableDetector", () => {
  describe("non-table text passthrough", () => {
    it("passes plain text through immediately", () => {
      // given:
      const chunks = ["hello world\n"];

      // when:
      const { output, warnings } = feedAll(chunks);

      // then:
      assert.strictEqual(output, "hello world\n");
      assert.strictEqual(warnings.length, 0);
    });

    it("passes multiple lines of plain text through", () => {
      // given:
      const chunks = ["line1\nline2\nline3\n"];

      // when:
      const { output, warnings } = feedAll(chunks);

      // then:
      assert.strictEqual(output, "line1\nline2\nline3\n");
      assert.strictEqual(warnings.length, 0);
    });

    it("passes text without newlines on forceFlush", () => {
      // given:
      const chunks = ["hello"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      assert.strictEqual(output, "hello");
      assert.strictEqual(warnings.length, 0);
    });

    it("holds pending text with pipe until forceFlush", () => {
      // given:
      const detector = createTableDetector();

      // when:
      const { output: out1, warnings: w1 } = detector.feed("text with | pipe");
      const { output: out2, warnings: w2 } = detector.forceFlush();

      // then:
      assert.strictEqual(out1.join(""), "");
      assert.strictEqual(w1.length, 0);
      assert.ok(out2.join("").includes("text with | pipe"));
      assert.strictEqual(w2.length, 0);
    });

    it("passes non-table line with pipe through when no table is active", () => {
      // given:
      const chunks = ["Choose A | B\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // A line containing pipe but not starting with "|" should not trigger
      // table detection when no table is currently being buffered
      assert.strictEqual(output, "Choose A | B\n");
      assert.strictEqual(warnings.length, 0);
    });
  });

  describe("table detection and formatting", () => {
    it("detects and formats a simple table with column padding", () => {
      // given:
      const chunks = ["| A | B |\n|---|---|\n| 1 | 2 |\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // formatMarkdownTable pads columns to equal width: "| A   | B   |"
      assert.ok(output.includes("| A   | B   |"));
      assert.ok(output.includes("| --- | --- |"));
      assert.ok(output.includes("| 1   | 2   |"));
      assert.strictEqual(warnings.length, 0);
    });

    it("buffers table lines and outputs non-table text after table ends", () => {
      // given:
      const chunks = ["| A | B |\n|---|---|\n| 1 | 2 |\nafter table\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      assert.ok(output.includes("| A   | B   |"));
      assert.ok(output.includes("after table\n"));
      assert.strictEqual(warnings.length, 0);
    });

    it("detects table continuation without leading pipe and formats it", () => {
      // given:
      const chunks = ["| A | B |\n|---|---|\n1 | 2\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // "1 | 2" should be treated as table continuation and formatted with padding
      assert.ok(output.includes("| 1   | 2   |"));
      assert.strictEqual(warnings.length, 0);
    });

    it("formats table on forceFlush when table is still active", () => {
      // given:
      const chunks = ["| A | B |\n|---|---|\n| 1 | 2 |"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // Table is incomplete (no trailing newline on last line), but forceFlush should still output it
      assert.ok(output.includes("| A   | B   |"));
      assert.strictEqual(warnings.length, 0);
    });

    it("preserves trailing empty lines after table", () => {
      // given:
      const chunks = ["| A | B |\n|---|---|\n| 1 | 2 |\n\nafter\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // The empty line between table and "after" should be preserved
      assert.ok(output.includes("\n\nafter"));
      assert.strictEqual(warnings.length, 0);
    });

    it("handles multiple tables in sequence", () => {
      // given:
      const chunks = [
        "| A | B |\n|---|---|\n| 1 | 2 |\ntext\n| X | Y |\n|---|---|\n| 3 | 4 |\n",
      ];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // Both tables should be formatted with padding
      assert.ok(output.includes("| A   | B   |"));
      assert.ok(output.includes("| X   | Y   |"));
      assert.ok(output.includes("text"));
      assert.strictEqual(warnings.length, 0);
    });
  });

  describe("streaming (chunked input)", () => {
    it("handles table fed in small chunks", () => {
      // given:
      const chunks = ["|", " A ", "| B |\n", "|---|---|\n", "| 1 | 2 |\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // Even when fed character-by-character, table should be formatted
      assert.ok(output.includes("| A   | B   |"));
      assert.ok(output.includes("| 1   | 2   |"));
      assert.strictEqual(warnings.length, 0);
    });

    it("outputs non-table text immediately even between table chunks", () => {
      // given:
      const chunks = ["hello\n| A | B |\n"];

      // when:
      const { output, warnings } = feedAll(chunks);

      // then:
      // "hello\n" should be output immediately, then table starts buffering
      assert.ok(output.includes("hello\n"));
      assert.strictEqual(warnings.length, 0);
    });

    it("holds pending non-table text with pipe until resolved", () => {
      // given:
      const detector = createTableDetector();

      // when:
      const { output: out1, warnings: w1 } = detector.feed("maybe | pipe");
      const { output: out2, warnings: w2 } = detector.feed("\n");

      // then:
      // Held because it contains pipe
      assert.strictEqual(out1.length, 0);
      assert.strictEqual(w1.length, 0);
      // The newline resolves the line; it's not a table start, so it's passed through
      assert.ok(out2.length > 0);
      assert.ok(out2.join("").includes("maybe | pipe"));
      assert.strictEqual(w2.length, 0);
    });

    it("accumulates table across multiple feed calls", () => {
      // given:
      const detector = createTableDetector();

      // when:
      detector.feed("| A | B |\n");
      detector.feed("|---|---|\n");
      detector.feed("| 1 | 2 |\n");
      const { output, warnings } = detector.forceFlush();

      // then:
      // Table state persists across feed calls; formatted on forceFlush
      assert.ok(output.join("").includes("| A   | B   |"));
      assert.strictEqual(warnings.length, 0);
    });
  });

  describe("code block handling", () => {
    it("disables table detection inside code blocks", () => {
      // given:
      const chunks = ["```\n| A | B |\n|---|---|\n```\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // Lines inside code block should pass through as-is (no formatting/padding)
      assert.ok(output.includes("```"));
      assert.ok(output.includes("| A | B |"));
      // Should NOT be padded (i.e. not "| A   | B   |")
      assert.ok(!output.includes("| A   | B   |"));
      assert.strictEqual(warnings.length, 0);
    });

    it("flushes active table when entering code block", () => {
      // given:
      const chunks = ["| A | B |\n|---|---|\n```\ncode\n```\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // Table should be formatted before code block starts
      assert.ok(output.includes("| A   | B   |"));
      assert.ok(output.includes("```"));
      assert.strictEqual(warnings.length, 0);
    });

    it("toggles code block state on each backtick fence", () => {
      // given:
      const chunks = ["```\n| A | B |\n```\n| X | Y |\n|---|---|\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // First table inside code block: passthrough (no padding)
      assert.ok(output.includes("| A | B |"));
      assert.ok(!output.includes("| A   | B   |"));
      // Second table outside code block: formatted (with padding)
      assert.ok(output.includes("| X   | Y   |"));
      assert.strictEqual(warnings.length, 0);
    });

    it("recognizes code block with language specifier", () => {
      // given:
      const chunks = ["```python\n| A | B |\n```\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // ```python should toggle code block; table inside should not be formatted
      assert.ok(output.includes("```python"));
      assert.ok(output.includes("| A | B |"));
      assert.ok(!output.includes("| A   | B   |"));
      assert.strictEqual(warnings.length, 0);
    });
  });

  describe("MAX_TABLE_LINES overflow", () => {
    it("formats table at exactly MAX_TABLE_LINES (200 lines)", () => {
      // given:
      const lines = ["| A | B |\n|---|---|\n"];
      // 198 data rows = 200 total lines (exactly at limit, not over)
      for (let i = 0; i < 198; i++) {
        lines.push(`| ${i} | val |\n`);
      }

      // when:
      const { output, warnings } = feedAllAndFlush(lines);

      // then:
      // Should be formatted (at limit, not over)
      assert.ok(output.includes("| A   | B   |"));
      assert.ok(!output.includes("| A | B |"));
      assert.strictEqual(warnings.length, 0);
    });

    it("falls back to unformatted output for oversized tables (201 lines)", () => {
      // given:
      const lines = ["| A | B |\n|---|---|\n"];
      // 199 data rows = 201 total lines (over limit)
      for (let i = 0; i < 199; i++) {
        lines.push(`| ${i} | val |\n`);
      }

      // when:
      const { output, warnings } = feedAllAndFlush(lines);

      // then:
      // Should output all lines unformatted (no column padding)
      assert.ok(output.includes("| A | B |"));
      assert.ok(output.includes("|---|---|"));
      // Should NOT have padded columns (which formatMarkdownTable would produce)
      assert.ok(!output.includes("| A   | B   |"));
      assert.strictEqual(warnings.length, 0);
    });
  });

  describe("formatTable error handling", () => {
    it("falls back to raw output and produces warning on format error", () => {
      // given:
      const detector = createTableDetector(throwingFormatter);

      // when:
      const { output: feedOutput, warnings: feedWarnings } = detector.feed(
        "| A | B |\n|---|---|\n| 1 | 2 |\n",
      );
      const { output: flushOutput, warnings: flushWarnings } =
        detector.forceFlush();

      // then:
      const allOutput = [...feedOutput, ...flushOutput].join("");
      // Raw lines should be output as-is (no padding from formatter)
      assert.ok(allOutput.includes("| A | B |"));
      assert.ok(allOutput.includes("| 1 | 2 |"));
      // Should NOT have padded columns since formatter threw
      assert.ok(!allOutput.includes("| A   | B   |"));

      // Warnings should contain the error message
      const allWarnings = [...feedWarnings, ...flushWarnings];
      assert.strictEqual(allWarnings.length, 1);
      assert.ok(allWarnings[0].includes("Warning: Table formatting failed:"));
      assert.ok(allWarnings[0].includes("format error for testing"));
    });

    it("produces no warnings when formatting succeeds", () => {
      // given:
      const chunks = ["| A | B |\n|---|---|\n| 1 | 2 |\n"];

      // when:
      const { warnings } = feedAllAndFlush(chunks);

      // then:
      assert.strictEqual(warnings.length, 0);
    });

    it("preserves Error message in warning on format error", () => {
      // given:
      const detector = createTableDetector(() => {
        throw new Error("custom error message");
      });

      // when:
      detector.feed("| A | B |\n|---|---|\n");
      const { warnings } = detector.forceFlush();

      // then:
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("custom error message"));
    });

    it("handles non-Error thrown value in warning", () => {
      // given:
      const detector = createTableDetector(() => {
        throw "string error"; // eslint-disable-line no-throw-literal
      });

      // when:
      detector.feed("| A | B |\n|---|---|\n");
      const { warnings } = detector.forceFlush();

      // then:
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("string error"));
    });

    it("produces warning when code block flushes table and formatter throws", () => {
      // given:
      const detector = createTableDetector(throwingFormatter);

      // when:
      const { output, warnings } = detector.feed("| A | B |\n|---|---|\n```\n");

      // then:
      // Code block entry flushes the table; formatter throws → raw output + warning
      const allOutput = output.join("");
      assert.ok(allOutput.includes("| A | B |"));
      assert.ok(!allOutput.includes("| A   | B   |"));
      assert.ok(allOutput.includes("```"));
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("Warning: Table formatting failed:"));
      assert.ok(warnings[0].includes("format error for testing"));
    });
  });

  describe("edge cases", () => {
    it("returns empty output and warnings for feed with empty string", () => {
      // given:
      const detector = createTableDetector();

      // when:
      const { output, warnings } = detector.feed("");

      // then:
      // Empty chunk is a no-op
      assert.strictEqual(output.length, 0);
      assert.strictEqual(warnings.length, 0);
    });

    it("returns empty output and warnings for forceFlush with no pending content", () => {
      // given:
      const detector = createTableDetector();

      // when:
      const { output, warnings } = detector.forceFlush();

      // then:
      assert.strictEqual(output.length, 0);
      assert.strictEqual(warnings.length, 0);
    });

    it("returns empty on second consecutive forceFlush", () => {
      // given:
      const detector = createTableDetector();
      detector.feed("| A | B |\n|---|---|\n| 1 | 2 |\n");

      // when:
      detector.forceFlush(); // first flush
      const { output, warnings } = detector.forceFlush(); // second flush

      // then:
      assert.strictEqual(output.length, 0);
      assert.strictEqual(warnings.length, 0);
    });

    it("adds incomplete table line to buffer on forceFlush and formats it", () => {
      // given:
      const detector = createTableDetector();

      // when:
      // Feed table header+separator, then incomplete row without newline
      detector.feed("| A | B |\n|---|---|\n");
      detector.feed("| 1 | 2 |"); // no trailing newline
      const { output, warnings } = detector.forceFlush();

      // then:
      // forceFlush should add the incomplete line to tableLines and format it
      const allOutput = output.join("");
      assert.ok(allOutput.includes("| 1   | 2   |"));
      assert.strictEqual(warnings.length, 0);
    });
  });

  describe("return structure", () => {
    it("returns { output: string[], warnings: string[] } from feed", () => {
      // given:
      const detector = createTableDetector();

      // when:
      const result = detector.feed("hello\n");

      // then:
      assert.ok(Array.isArray(result.output));
      assert.ok(Array.isArray(result.warnings));
      assert.strictEqual(typeof result.output[0], "string");
    });

    it("returns { output: string[], warnings: string[] } from forceFlush", () => {
      // given:
      const detector = createTableDetector();

      // when:
      const result = detector.forceFlush();

      // then:
      assert.ok(Array.isArray(result.output));
      assert.ok(Array.isArray(result.warnings));
    });

    it("has no side effects (no I/O)", () => {
      // given:
      const detector = createTableDetector();

      // when:
      const feedResult = detector.feed("| A | B |\n|---|---|\n| 1 | 2 |\n");
      const flushResult = detector.forceFlush();

      // then:
      // Results are returned without I/O side effects
      assert.ok(Array.isArray(feedResult.output));
      assert.ok(Array.isArray(feedResult.warnings));
      assert.ok(Array.isArray(flushResult.output));
      assert.ok(Array.isArray(flushResult.warnings));
      assert.ok(flushResult.output.join("").includes("| A"));
      assert.strictEqual(flushResult.warnings.length, 0);
    });
  });
});
