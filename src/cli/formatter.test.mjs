/** @import { MessageContentToolResult } from "../model" */
import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { styleText } from "node:util";
import { lineHash } from "../utils/lineHash.mjs";
import {
  formatArgs,
  formatMarkdownTable,
  formatToolResult,
  formatToolUse,
} from "./formatter.mjs";

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** @param {string} s */
const stripAnsi = (s) => s.replace(ANSI_PATTERN, "");

describe("formatArgs", () => {
  it("renders an empty array inline", () => {
    assert.equal(formatArgs([]), "args: []");
  });

  it("falls back to JSON for undefined input", () => {
    assert.equal(formatArgs(undefined), "args: []");
  });

  it("keeps short single-line args compact", () => {
    assert.equal(formatArgs(["-la", "src"]), 'args: ["-la","src"]');
  });

  it("switches to block form when any arg contains a newline", () => {
    const script = 'set -e\nfor f in *.mjs; do\n  echo "$f"\ndone';
    assert.equal(
      formatArgs(["-c", script]),
      [
        "args:",
        '  - "-c"',
        "  - |",
        "      set -e",
        "      for f in *.mjs; do",
        '        echo "$f"',
        "      done",
      ].join("\n"),
    );
  });

  it("handles trailing newlines inside a multi-line arg", () => {
    assert.equal(
      formatArgs(["-c", "echo hi\n"]),
      ["args:", '  - "-c"', "  - |", "      echo hi", "      "].join("\n"),
    );
  });

  it("switches to block form for long single-line args", () => {
    const script =
      "total=0; for i in {1..1000}; do ((total += i)); done; echo $total";
    assert.equal(
      formatArgs(["-c", script]),
      ["args:", '  - "-c"', "  - |", `      ${script}`].join("\n"),
    );
  });

  it("keeps short single-line args compact even when many are present", () => {
    assert.equal(
      formatArgs(["-n", "5", "-A", "2", "pattern", "src"]),
      'args: ["-n","5","-A","2","pattern","src"]',
    );
  });
});

describe("formatToolUse", () => {
  it("formats exec_command with a multi-line script readably", async () => {
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t1",
      toolName: "exec_command",
      input: {
        command: "bash",
        args: ["-c", 'echo one\necho "two"'],
      },
    });

    assert.equal(
      output,
      [
        "exec_command",
        'command: "bash"',
        "args:",
        '  - "-c"',
        "  - |",
        "      echo one",
        '      echo "two"',
      ].join("\n"),
    );
  });

  it("formats tmux_command args in block form when multi-line", async () => {
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t2",
      toolName: "tmux_command",
      input: {
        command: "send-keys",
        args: ["session:0", "echo a\necho b"],
      },
    });

    assert.equal(
      output,
      [
        "tmux_command",
        "command: send-keys",
        "args:",
        '  - "session:0"',
        "  - |",
        "      echo a",
        "      echo b",
      ].join("\n"),
    );
  });

  it("keeps exec_command single-line args compact", async () => {
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t3",
      toolName: "exec_command",
      input: {
        command: "rg",
        args: ["foo", "src"],
      },
    });

    assert.equal(
      output,
      ["exec_command", 'command: "rg"', 'args: ["foo","src"]'].join("\n"),
    );
  });
});

describe("formatToolUse (patch_file)", () => {
  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];

  const generateRandomString = () => Math.random().toString(36).substring(2);

  /**
   * @param {string[]} lines
   * @returns {Promise<string>}
   */
  const writeTmp = async (lines) => {
    const tmpFilePath = `tmp/cliFormatterTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));
    return tmpFilePath;
  };

  afterEach(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  it("renders a replace block with original lines as removals and body as additions", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
    ]);
    const patch = [
      `REPLACE abc 3:${lineHash("charlie")}-4:${lineHash("delta")}`,
      "first new",
      "second new",
    ].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t4",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then:
    assert.ok(output.startsWith(`patch_file\npath: ${tmpFilePath}\npatch:\n`));
    assert.equal(
      stripAnsi(output),
      [
        "patch_file",
        `path: ${tmpFilePath}`,
        "patch:",
        `REPLACE abc 3:${lineHash("charlie")}-4:${lineHash("delta")}`,
        "- charlie",
        "- delta",
        "+ first new",
        "+ second new",
      ].join("\n"),
    );
  });

  it("renders multiple blocks including a multi-line insert", async () => {
    // given:
    const tmpFilePath = await writeTmp(["one", "two", "three", "four", "five"]);
    const patch = [
      `REPLACE a1a 1:${lineHash("one")}-1:${lineHash("one")}`,
      "first new",
      `INSERT_AFTER a1a 5:${lineHash("five")}`,
      "appended A",
      "appended B",
    ].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t5",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then: every body line of the insert is prefixed with "+ ".
    const stripped = stripAnsi(output);
    assert.ok(
      stripped.includes(
        `REPLACE a1a 1:${lineHash("one")}-1:${lineHash("one")}\n- one\n+ first new`,
      ),
    );
    assert.ok(
      stripped.includes(
        `INSERT_AFTER a1a 5:${lineHash("five")}\n+ appended A\n+ appended B`,
      ),
    );
  });

  it("renders unchanged lines inside a replace range as context (no -/+)", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
    ]);
    // Replace 1-5 but only line 3 ("charlie") actually changes; the
    // first/last two lines round-trip unchanged.
    const patch = [
      `REPLACE abc 1:${lineHash("alpha")}-5:${lineHash("echo")}`,
      "alpha",
      "bravo",
      "CHARLIE",
      "delta",
      "echo",
    ].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t12",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then: only the changed line shows -/+; the rest are context "  ".
    assert.equal(
      stripAnsi(output),
      [
        "patch_file",
        `path: ${tmpFilePath}`,
        "patch:",
        `REPLACE abc 1:${lineHash("alpha")}-5:${lineHash("echo")}`,
        "  alpha",
        "  bravo",
        "- charlie",
        "+ CHARLIE",
        "  delta",
        "  echo",
      ].join("\n"),
    );
  });

  it("renders a no-op replace as all context lines", async () => {
    // given: body matches the original range exactly.
    const tmpFilePath = await writeTmp(["one", "two", "three"]);
    const patch = [
      `REPLACE abc 1:${lineHash("one")}-3:${lineHash("three")}`,
      "one",
      "two",
      "three",
    ].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t13",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then:
    assert.equal(
      stripAnsi(output),
      [
        "patch_file",
        `path: ${tmpFilePath}`,
        "patch:",
        `REPLACE abc 1:${lineHash("one")}-3:${lineHash("three")}`,
        "  one",
        "  two",
        "  three",
      ].join("\n"),
    );
  });

  it("renders a deletion (empty body) as a removal-only block", async () => {
    // given:
    const tmpFilePath = await writeTmp(["keep", "drop me", "keep too"]);
    const patch = [
      `REPLACE a2a 2:${lineHash("drop me")}-2:${lineHash("drop me")}`,
    ].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t6",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then:
    assert.equal(
      stripAnsi(output),
      [
        "patch_file",
        `path: ${tmpFilePath}`,
        "patch:",
        `REPLACE a2a 2:${lineHash("drop me")}-2:${lineHash("drop me")}`,
        "- drop me",
      ].join("\n"),
    );
  });

  it("renders empty or undefined patch as a blank patch section", async () => {
    // when/then: both inputs collapse to "" before reaching the renderer.
    for (const patch of ["", undefined]) {
      const output = await formatToolUse({
        type: "tool_use",
        toolUseId: "t7",
        toolName: "patch_file",
        input: { filePath: "empty.txt", patch },
      });
      assert.equal(output, "patch_file\npath: empty.txt\npatch:\n");
    }
  });

  it("renders a replace block targeting a blank line", async () => {
    // given: line 2 is blank; hash of "" is "00".
    const tmpFilePath = await writeTmp(["alpha", "", "charlie"]);
    const patch = [
      `REPLACE abc 2:${lineHash("")}-2:${lineHash("")}`,
      "bravo",
    ].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t14",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then: the original blank line shows as a "- " removal, body as "+".
    assert.equal(
      stripAnsi(output),
      [
        "patch_file",
        `path: ${tmpFilePath}`,
        "patch:",
        `REPLACE abc 2:${lineHash("")}-2:${lineHash("")}`,
        "- ",
        "+ bravo",
      ].join("\n"),
    );
  });

  it("renders hash values in the header", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "old line", "charlie"]);
    const patch = [
      `REPLACE abc 2:${lineHash("old line")}-2:${lineHash("old line")}`,
      "new",
    ].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t9",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then:
    const stripped = stripAnsi(output);
    const header = `REPLACE abc 2:${lineHash("old line")}-2:${lineHash("old line")}`;
    assert.ok(stripped.includes(header));
    assert.ok(stripped.includes("- old line"));
    assert.ok(stripped.includes("+ new"));
    // Header lines pass through styleText("cyan", ...) which is TTY-aware,
    // so we just verify the formatter wraps it the same way.
    const headerStyled = styleText("cyan", header);
    assert.ok(output.includes(headerStyled));
  });

  it("falls back to verbatim highlight when the file cannot be read", async () => {
    // given:
    const patch = [
      `REPLACE abc 3:${lineHash("anything")}-4:${lineHash("anything2")}`,
      "first new",
      "second new",
    ].join("\n");

    // when: filePath does not exist on disk
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t10",
      toolName: "patch_file",
      input: { filePath: "does/not/exist.mjs", patch },
    });

    // then: still shows the new content with `+` markers, but no `- ...` lines
    const stripped = stripAnsi(output);
    assert.ok(
      stripped.startsWith("patch_file\npath: does/not/exist.mjs\npatch:\n"),
    );
    assert.ok(
      stripped.includes(
        `REPLACE abc 3:${lineHash("anything")}-4:${lineHash("anything2")}`,
      ),
    );
    assert.ok(stripped.includes("+ first new"));
    assert.ok(stripped.includes("+ second new"));
    assert.ok(!stripped.includes("- "));
  });

  it("falls back to verbatim highlight when the patch fails to parse", async () => {
    // given: patch that fails to parse
    const patch = ["REPLACE abc 1-1", "new"].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t11",
      toolName: "patch_file",
      input: { filePath: "anything.mjs", patch },
    });

    // then: verbatim styling still applies, headers cyan, body green
    assert.equal(
      stripAnsi(output),
      [
        "patch_file",
        "path: anything.mjs",
        "patch:",
        "REPLACE abc 1-1",
        "new",
      ].join("\n"),
    );
  });

  it("falls back to verbatim highlight when no nonce can be extracted", async () => {
    // given: patch contains no "REPLACE ..." or "INSERT ..." header at all.
    const patch = ["plain text", "with no markers"].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t15",
      toolName: "patch_file",
      input: { filePath: "anything.mjs", patch },
    });

    // then: body lines are still passed through verbatim styling.
    assert.equal(
      stripAnsi(output),
      [
        "patch_file",
        "path: anything.mjs",
        "patch:",
        "plain text",
        "with no markers",
      ].join("\n"),
    );
  });
});

describe("formatToolUse (read_file)", () => {
  it("renders filePath alone when no offset/limit set", async () => {
    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "r1",
      toolName: "read_file",
      input: { filePath: "src/app.mjs" },
    });

    // then:
    assert.equal(output, "read_file\nfilePath: src/app.mjs");
  });

  it("includes offset and limit when provided", async () => {
    // given:
    const input = { filePath: "src/app.mjs", offset: 10, limit: 50 };

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "r2",
      toolName: "read_file",
      input,
    });

    // then:
    assert.equal(
      output,
      ["read_file", "filePath: src/app.mjs", "offset: 10", "limit: 50"].join(
        "\n",
      ),
    );
  });
});

describe("formatToolResult (read_file)", () => {
  it("colors line number and hash prefix in gray", async () => {
    // given:
    const toolResult = /** @type {MessageContentToolResult} */ ({
      type: "tool_result",
      toolUseId: "r1",
      toolName: "read_file",
      content: [
        {
          type: "text",
          text: "1:a3|function hello() {\n2:b7|  return 42;\n3:c1|}",
        },
      ],
      isError: false,
    });

    // when:
    const output = formatToolResult(toolResult);

    // then:
    const grayPrefix = styleText("gray", "1:a3|");
    assert.ok(output.startsWith(grayPrefix));
    assert.ok(output.includes(styleText("gray", "2:b7|")));
    assert.ok(output.includes(styleText("gray", "3:c1|")));
  });
});
describe("formatMarkdownTable", () => {
  /** @type {(() => void)[]} */
  const cleanups = [];

  afterEach(() => {
    for (const cleanup of [...cleanups].reverse()) {
      cleanup();
    }
    cleanups.length = 0;
  });
  it("aligns a simple two-column table", () => {
    // given:
    const lines = [
      "| Name | Value |", //
      "|------|-------|", //
      "| foo | bar |", //
    ];

    // when:
    const result = formatMarkdownTable(lines);

    // then:
    assert.equal(
      result,
      [
        "| Name   | Value   |",
        "| ------ | ------- |",
        "| foo    | bar     |",
      ].join("\n"),
    );
  });

  it("handles rows without leading/trailing pipes", () => {
    // given:
    const lines = [
      "a | b", //
      "---|---",
      "x | y",
    ];

    // when:
    const result = formatMarkdownTable(lines);

    // then:
    assert.equal(
      result,
      [
        "| a   | b   |", // keep format
        "| --- | --- |",
        "| x   | y   |",
      ].join("\n"),
    );
  });

  it("aligns columns with CJK full-width characters", () => {
    // given:
    const lines = [
      "| 名前 | 値 |", // keep format
      "|------|----|",
      "| あ | 100 |",
    ];

    // when:
    const result = formatMarkdownTable(lines);

    // then: "名前" = width 4, "値" = width 2, "------" = width 6
    assert.equal(
      result,
      [
        "| 名前   | 値   |", // keep format
        "| ------ | ---- |",
        "| あ     | 100  |",
      ].join("\n"),
    );
  });

  it("strips ANSI codes when calculating widths but preserves them in output", () => {
    // given: a cell with ANSI-styled text, target width comes from "-------"(7)
    const styled = styleText("red", "foo");
    const lines = [
      `| ${styled} | bar |`, // keep format
      "|-------|-----|",
    ];

    // when:
    const result = formatMarkdownTable(lines);

    // then: "foo" stripAnsi width = 3, target = 7 -> 4 padding spaces
    const ansiStripped = stripAnsi(result);
    assert.equal(
      ansiStripped,
      [
        "| foo     | bar   |", // keep format
        "| ------- | ----- |",
      ].join("\n"),
    );
  });

  it("handles a single-column table", () => {
    // given:
    const lines = [
      "| Item |", // keep format
      "|------|",
      "| a |",
      "| bb |",
    ];

    // when:
    const result = formatMarkdownTable(lines);

    // then:
    assert.equal(
      result,
      [
        "| Item   |", // keep format
        "| ------ |",
        "| a      |",
        "| bb     |",
      ].join("\n"),
    );
  });

  it("preserves empty cells", () => {
    // given:
    const lines = [
      "| A | B | C |", // keep format
      "|---|---|---|",
      "| x | | z |",
    ];

    // when:
    const result = formatMarkdownTable(lines);

    // then: empty cell fills to column width with spaces
    assert.equal(
      result,
      [
        "| A   | B   | C   |",
        "| --- | --- | --- |",
        "| x   |     | z   |",
      ].join("\n"),
    );
  });

  it("respects escaped pipes inside cells", () => {
    // given: escaped pipe \|
    const lines = [
      "| Col1 | Col2 |", // keep format
      "|------|------|",
      "| a \\| b | c |",
    ];

    // when:
    const result = formatMarkdownTable(lines);

    // then: `a | b` is one cell (escaped pipe preserved and unescaped)
    assert.equal(
      result,
      [
        "| Col1   | Col2   |",
        "| ------ | ------ |",
        "| a | b  | c      |",
      ].join("\n"),
    );
  });

  it("returns empty string for empty input", () => {
    assert.equal(formatMarkdownTable([]), "");
  });

  it("handles tables with varying column counts (best-effort)", () => {
    // given: row 2 has fewer columns
    const lines = [
      "| A | B | C |", // keep format
      "| D | E |",
    ];

    // when:
    const result = formatMarkdownTable(lines);

    // then: pads to max column count
    assert.equal(
      result,
      [
        "| A | B | C |", // keep format
        "| D | E |   |",
      ].join("\n"),
    );
  });

  it("aligns columns with emoji (display width 2)", () => {
    // given: emoji like 🎉 and 🚀 have display width 2
    const lines = [
      "| Emoji | Desc |", // keep format
      "|-------|------|",
      "| 🎉 | party |",
      "| 🚀 | rocket |",
    ];

    // when:
    const result = formatMarkdownTable(lines);

    // then: emoji cells padded to width 6 (separator "------" = 6)
    assert.equal(
      result,
      [
        "| Emoji   | Desc   |", // keep format
        "| ------- | ------ |",
        "| 🎉      | party  |",
        "| 🚀      | rocket |",
      ].join("\n"),
    );
  });

  it("wraps long cells when table exceeds maxWidth", () => {
    // given:
    const lines = [
      "| Name | Description |",
      "|------|-------------|",
      "| foo  | abcdefghijklmnop |",
    ];

    // when:
    const result = formatMarkdownTable(lines, 24);

    // then: long cell wraps to next visual line; all lines ≤ 24 chars
    assert.equal(
      result,
      [
        "| Name  | Description  |",
        "| ----- | ------------ |",
        "| foo   | abcdefghijkl |",
        "|       | mnop         |",
      ].join("\n"),
    );
  });

  it("wraps cells and aligns multi-line rows", () => {
    // given:
    const lines = [
      "| Short | A very long cell content |",
      "|-------|--------------------------|",
      "| x     | abcdefghijklmnopqrstuvw |",
    ];

    // when:
    const result = formatMarkdownTable(lines, 30);

    // then: header wraps; separator regenerates to fit; data wraps
    assert.equal(
      result,
      [
        "| Short  | A very long cell  |",
        "|        | content           |",
        "| ------ | ----------------- |",
        "| x      | abcdefghijklmnopq |",
        "|        | rstuvw            |",
      ].join("\n"),
    );
  });

  it("preserves ANSI codes across wrapped lines", () => {
    // given:
    const prev = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    cleanups.push(() => {
      process.env.FORCE_COLOR = prev;
    });
    const styled = styleText("red", "abcdefghijklmnopqrst");
    const lines = [`| ${styled} |`, "|--------------------|"];

    // when:
    const result = formatMarkdownTable(lines, 18);

    // then: ANSI codes preserved; stripped output matches expected layout
    assert.ok(result.includes("\x1b["), "ANSI codes should be preserved");
    assert.equal(
      stripAnsi(result),
      [
        "| abcdefghijklmn |", // keep format
        "| opqrst         |",
        "| -------------- |",
      ].join("\n"),
    );
  });

  it("wraps CJK wide characters correctly", () => {
    // given:
    const lines = [
      "| 名前 | 説明文は長い文字列です |",
      "|------|------------------------|",
      "| あ   | あいうえおかきくけこ |",
    ];

    // when:
    const result = formatMarkdownTable(lines, 30);

    // then: CJK chars counted as width 2; wraps within maxWidth
    assert.equal(
      result,
      [
        "| 名前  | 説明文は長い文字列 |",
        "|       | です               |",
        "| ----- | ------------------ |",
        "| あ    | あいうえおかきくけ |",
        "|       | こ                 |",
      ].join("\n"),
    );
  });

  it("handles maxWidth too small to fit (falls back to natural widths)", () => {
    // given:
    const lines = [
      "| A | B | C |", // keep format
      "|---|---|---|",
      "| 1 | 2 | 3 |",
    ];

    // when: maxWidth=10 is too small for 3 columns (min 3 each + gutters)
    const result = formatMarkdownTable(lines, 10);

    // then: falls back to natural widths (overflow allowed, no crash)
    assert.equal(
      result,
      [
        "| A   | B   | C   |",
        "| --- | --- | --- |",
        "| 1   | 2   | 3   |",
      ].join("\n"),
    );
  });
});
