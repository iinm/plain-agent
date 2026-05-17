import assert from "node:assert";
import { describe, it } from "node:test";
import { styleText } from "node:util";
import { createStreamFormatter } from "./streamFormatter.mjs";

/**
 * Helper: strip ANSI escape codes for assertion comparison.
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape code pattern
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Helper: feed multiple chunks and collect all output/warnings.
 * @param {string[]} chunks
 * @param {(lines: string[]) => string} [formatTable]
 * @returns {{ output: string, warnings: string[] }}
 */
function feedAll(chunks, formatTable) {
  const formatter = createStreamFormatter(formatTable);
  const allOutput = [];
  const allWarnings = [];
  for (const chunk of chunks) {
    const { output, warnings } = formatter.feed(chunk);
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
  const formatter = createStreamFormatter(formatTable);
  const allOutput = [];
  const allWarnings = [];
  for (const chunk of chunks) {
    const { output, warnings } = formatter.feed(chunk);
    allOutput.push(...output);
    allWarnings.push(...warnings);
  }
  const { output, warnings } = formatter.forceFlush();
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

describe("createStreamFormatter", () => {
  describe("non-table text passthrough", () => {
    it("passes multiple lines of plain text through", () => {
      // given:
      const chunks = ["line1\nline2\nline3\n"];

      // when:
      const { output, warnings } = feedAll(chunks);

      // then:
      assert.strictEqual(output, "line1\nline2\nline3\n");
      assert.strictEqual(warnings.length, 0);
    });

    it("outputs text without newlines on forceFlush", () => {
      // given:
      const chunks = ["hello"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      assert.strictEqual(output, "hello");
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

    it("accumulates table across multiple feed calls", () => {
      // given:
      const formatter = createStreamFormatter();

      // when:
      formatter.feed("| A | B |\n");
      formatter.feed("|---|---|\n");
      formatter.feed("| 1 | 2 |\n");
      const { output, warnings } = formatter.forceFlush();

      // then:
      // Table state persists across feed calls; formatted on forceFlush
      assert.ok(output.join("").includes("| A   | B   |"));
      assert.strictEqual(warnings.length, 0);
    });

    it("converts **bold** when split across chunks on the same line", () => {
      // given: **bold** split across two chunks; both accumulate in pendingLine
      const formatter = createStreamFormatter();

      // when:
      const { output: out1 } = formatter.feed("This is **bol");
      const { output: out2 } = formatter.feed("d** text\n");
      const { output: out3, warnings } = formatter.forceFlush();

      // then:
      // \n completes the line → processLine sees "This is **bold** text" and converts it
      const allOutput = [...out1, ...out2, ...out3].join("");
      assert.strictEqual(
        allOutput,
        `This is ${styleText("bold", "bold")} text\n`,
      );
      assert.strictEqual(warnings.length, 0);
    });
  });

  describe("code block handling", () => {
    it("disables table detection and **bold** conversion inside code blocks", () => {
      // given:
      const chunks = ["```\n| A | B |\n**bold**\n```\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // Lines inside code block should pass through as-is (no formatting/padding/bold)
      assert.ok(output.includes("```"));
      assert.ok(output.includes("| A | B |"));
      // Should NOT be padded (i.e. not "| A   | B   |")
      assert.ok(!output.includes("| A   | B   |"));
      // **bold** should stay raw (no ANSI codes)
      assert.ok(output.includes("**bold**"));
      assert.ok(!output.includes("\x1b["));
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
      const formatter = createStreamFormatter(throwingFormatter);

      // when:
      const { output: feedOutput, warnings: feedWarnings } = formatter.feed(
        "| A | B |\n|---|---|\n| 1 | 2 |\n",
      );
      const { output: flushOutput, warnings: flushWarnings } =
        formatter.forceFlush();

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

    it("handles non-Error thrown value in warning", () => {
      // given:
      const formatter = createStreamFormatter(() => {
        throw "string error"; // eslint-disable-line no-throw-literal
      });

      // when:
      formatter.feed("| A | B |\n|---|---|\n");
      const { warnings } = formatter.forceFlush();

      // then:
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("string error"));
    });

    it("produces warning when code block flushes table and formatter throws", () => {
      // given:
      const formatter = createStreamFormatter(throwingFormatter);

      // when:
      const { output, warnings } = formatter.feed(
        "| A | B |\n|---|---|\n```\n",
      );

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

  describe("**bold** styling", () => {
    it("converts **bold** to ANSI bold on completed lines", () => {
      // given:
      const chunks = ["This is **bold** text\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      assert.strictEqual(output, `This is ${styleText("bold", "bold")} text\n`);
      assert.strictEqual(warnings.length, 0);
    });

    it("applies **bold** in table cells before column-width calculation", () => {
      // given: **Name** is 8 literal chars but bold "Name" is 4 display chars
      // Column width is determined by separator "----------" (10 chars)
      const chunks = [
        "| **Name** | Value |\n|----------|-------|\n| **foo**  | bar   |\n",
      ];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // ** markers are removed from display text; "Name" padded to width 10
      assert.strictEqual(
        stripAnsi(output),
        [
          "| Name       | Value   |",
          "| ---------- | ------- |",
          "| foo        | bar     |",
          "",
        ].join("\n"),
      );
      // bold ANSI codes wrap the cell content
      assert.strictEqual(
        output,
        [
          `| ${styleText("bold", "Name")}       | Value   |`,
          "| ---------- | ------- |",
          `| ${styleText("bold", "foo")}        | bar     |`,
          "",
        ].join("\n"),
      );
      assert.strictEqual(warnings.length, 0);
    });

    it("converts **bold** followed by punctuation", () => {
      // given:
      const chunks = ["This is **bold**.\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      assert.strictEqual(output, `This is ${styleText("bold", "bold")}.\n`);
      assert.strictEqual(warnings.length, 0);
    });

    it("does not convert **bold** inside inline code", () => {
      // given: `**bold**` is inline code — ** is adjacent to backtick, not space
      const chunks = ["Use `**bold**` for emphasis\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // ** adjacent to backtick → no match, left as-is
      assert.strictEqual(output, "Use `**bold**` for emphasis\n");
      assert.strictEqual(warnings.length, 0);
    });

    it("does not convert **bold** without surrounding whitespace", () => {
      // given: word**bold**word has no whitespace around **
      const chunks = ["word**bold**word\n"];

      // when:
      const { output, warnings } = feedAllAndFlush(chunks);

      // then:
      // No whitespace before/after ** → no match
      assert.strictEqual(output, "word**bold**word\n");
      assert.strictEqual(warnings.length, 0);
    });
  });

  describe("edge cases", () => {
    it("returns empty output and warnings for feed with empty string", () => {
      // given:
      const formatter = createStreamFormatter();

      // when:
      const { output, warnings } = formatter.feed("");

      // then:
      // Empty chunk is a no-op
      assert.strictEqual(output.length, 0);
      assert.strictEqual(warnings.length, 0);
    });

    it("returns empty output and warnings for forceFlush with no pending content", () => {
      // given:
      const formatter = createStreamFormatter();

      // when:
      const { output, warnings } = formatter.forceFlush();

      // then:
      assert.strictEqual(output.length, 0);
      assert.strictEqual(warnings.length, 0);
    });

    it("adds incomplete table line to buffer on forceFlush and formats it", () => {
      // given:
      const formatter = createStreamFormatter();

      // when:
      // Feed table header+separator, then incomplete row without newline
      formatter.feed("| A | B |\n|---|---|\n");
      formatter.feed("| 1 | 2 |"); // no trailing newline
      const { output, warnings } = formatter.forceFlush();

      // then:
      // forceFlush should add the incomplete line to tableLines and format it
      const allOutput = output.join("");
      assert.ok(allOutput.includes("| 1   | 2   |"));
      assert.strictEqual(warnings.length, 0);
    });
  });
});
