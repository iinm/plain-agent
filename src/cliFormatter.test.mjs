import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { styleText } from "node:util";
import { formatArgs, formatToolUse } from "./cliFormatter.mjs";

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
        "tool: exec_command",
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
        "tool: tmux_command",
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
      ["tool: exec_command", 'command: "rg"', 'args: ["foo","src"]'].join("\n"),
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
      "@@@ abc 3-4 HEAD=charlie",
      "first new",
      "second new",
      "@@@ abc",
    ].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t4",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then:
    assert.ok(
      output.startsWith(`tool: patch_file\npath: ${tmpFilePath}\npatch:\n`),
    );
    assert.equal(
      stripAnsi(output),
      [
        "tool: patch_file",
        `path: ${tmpFilePath}`,
        "patch:",
        "@@@ abc 3-4 HEAD=charlie",
        "- charlie",
        "- delta",
        "+ first new",
        "+ second new",
        "@@@ abc",
      ].join("\n"),
    );
  });

  it("renders multiple blocks including an insert", async () => {
    // given:
    const tmpFilePath = await writeTmp(["one", "two", "three", "four", "five"]);
    const patch = [
      "@@@ a1a 1-1 HEAD=one",
      "first new",
      "@@@ a1a",
      "",
      "@@@ a1a 5+",
      "second new",
      "@@@ a1a",
    ].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t5",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then:
    const stripped = stripAnsi(output);
    assert.ok(
      stripped.includes("@@@ a1a 1-1 HEAD=one\n- one\n+ first new\n@@@ a1a"),
    );
    assert.ok(stripped.includes("@@@ a1a 5+\n+ second new\n@@@ a1a"));
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
      "@@@ abc 1-5 HEAD=alpha",
      "alpha",
      "bravo",
      "CHARLIE",
      "delta",
      "echo",
      "@@@ abc",
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
        "tool: patch_file",
        `path: ${tmpFilePath}`,
        "patch:",
        "@@@ abc 1-5 HEAD=alpha",
        "  alpha",
        "  bravo",
        "- charlie",
        "+ CHARLIE",
        "  delta",
        "  echo",
        "@@@ abc",
      ].join("\n"),
    );
  });

  it("renders a no-op replace as all context lines", async () => {
    // given: body matches the original range exactly.
    const tmpFilePath = await writeTmp(["one", "two", "three"]);
    const patch = [
      "@@@ abc 1-3 HEAD=one",
      "one",
      "two",
      "three",
      "@@@ abc",
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
        "tool: patch_file",
        `path: ${tmpFilePath}`,
        "patch:",
        "@@@ abc 1-3 HEAD=one",
        "  one",
        "  two",
        "  three",
        "@@@ abc",
      ].join("\n"),
    );
  });

  it("renders a deletion (empty body) as a removal-only block", async () => {
    // given:
    const tmpFilePath = await writeTmp(["keep", "drop me", "keep too"]);
    const patch = ["@@@ a2a 2-2 HEAD=drop me", "@@@ a2a"].join("\n");

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
        "tool: patch_file",
        `path: ${tmpFilePath}`,
        "patch:",
        "@@@ a2a 2-2 HEAD=drop me",
        "- drop me",
        "@@@ a2a",
      ].join("\n"),
    );
  });

  it("handles an empty patch string", async () => {
    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t7",
      toolName: "patch_file",
      input: { filePath: "empty.txt", patch: "" },
    });

    // then:
    assert.equal(output, "tool: patch_file\npath: empty.txt\npatch:\n");
  });

  it("handles undefined patch as empty", async () => {
    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t8",
      toolName: "patch_file",
      input: { filePath: "empty.txt", patch: undefined },
    });

    // then:
    assert.equal(output, "tool: patch_file\npath: empty.txt\npatch:\n");
  });

  it("renders a HEAD annotation in the open marker", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "old line", "charlie"]);
    const patch = ["@@@ abc 2-2 HEAD=old line", "new", "@@@ abc"].join("\n");

    // when:
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t9",
      toolName: "patch_file",
      input: { filePath: tmpFilePath, patch },
    });

    // then:
    const stripped = stripAnsi(output);
    assert.ok(stripped.includes("@@@ abc 2-2 HEAD=old line"));
    assert.ok(stripped.includes("- old line"));
    assert.ok(stripped.includes("+ new"));
    // Header lines pass through styleText("cyan", ...) which is TTY-aware,
    // so we just verify the formatter wraps it the same way.
    const headerStyled = styleText("cyan", "@@@ abc 2-2 HEAD=old line");
    assert.ok(output.includes(headerStyled));
  });

  it("falls back to verbatim highlight when the file cannot be read", async () => {
    // given:
    const patch = [
      "@@@ abc 3-4 HEAD=anything",
      "first new",
      "second new",
      "@@@ abc",
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
      stripped.startsWith(
        "tool: patch_file\npath: does/not/exist.mjs\npatch:\n",
      ),
    );
    assert.ok(stripped.includes("@@@ abc 3-4 HEAD=anything"));
    assert.ok(stripped.includes("+ first new"));
    assert.ok(stripped.includes("+ second new"));
    assert.ok(!stripped.includes("- "));
  });

  it("falls back to verbatim highlight when the patch fails to parse", async () => {
    // given: patch with mismatched markers (no close)
    const patch = ["@@@ abc 1-1", "new"].join("\n");

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
        "tool: patch_file",
        "path: anything.mjs",
        "patch:",
        "@@@ abc 1-1",
        "new",
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
    assert.equal(output, "tool: read_file\nfilePath: src/app.mjs");
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
      [
        "tool: read_file",
        "filePath: src/app.mjs",
        "offset: 10",
        "limit: 50",
      ].join("\n"),
    );
  });
});
