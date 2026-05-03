import assert from "node:assert";
import { describe, it } from "node:test";
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
  it("formats a replace block with header and body styled", async () => {
    const diff = ["@@@ abc 3-4", "first new", "second new", "@@@ abc"].join(
      "\n",
    );

    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t4",
      toolName: "patch_file",
      input: { filePath: "src/app.mjs", diff },
    });

    assert.ok(
      output.startsWith("tool: patch_file\npath: src/app.mjs\ndiff:\n"),
    );
    // styleText() is TTY-aware, so ANSI codes may or may not appear
    // depending on the test environment. Compare on the stripped form.
    assert.equal(
      stripAnsi(output),
      [
        "tool: patch_file",
        "path: src/app.mjs",
        "diff:",
        "@@@ abc 3-4",
        "first new",
        "second new",
        "@@@ abc",
      ].join("\n"),
    );
  });

  it("formats multiple blocks including an insert", async () => {
    const diff = [
      "@@@ a1a 1-1",
      "first new",
      "@@@ a1a",
      "",
      "@@@ a1a 5+",
      "second new",
      "@@@ a1a",
    ].join("\n");

    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t5",
      toolName: "patch_file",
      input: { filePath: "lib/mod.mjs", diff },
    });

    const stripped = stripAnsi(output);
    assert.ok(stripped.includes("@@@ a1a 1-1"));
    assert.ok(stripped.includes("@@@ a1a 5+"));
    assert.ok(stripped.includes("first new"));
    assert.ok(stripped.includes("second new"));
  });

  it("handles an empty diff string", async () => {
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t7",
      toolName: "patch_file",
      input: { filePath: "empty.txt", diff: "" },
    });
    assert.equal(output, "tool: patch_file\npath: empty.txt\ndiff:\n");
  });

  it("handles undefined diff as empty", async () => {
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t8",
      toolName: "patch_file",
      input: { filePath: "empty.txt", diff: undefined },
    });
    assert.equal(output, "tool: patch_file\npath: empty.txt\ndiff:\n");
  });

  it("renders a HEAD-annotated open marker as a styled header", async () => {
    const diff = ['@@@ abc 2-2 HEAD="old"', "new", "@@@ abc"].join("\n");
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t9",
      toolName: "patch_file",
      input: { filePath: "src/app.mjs", diff },
    });
    const stripped = stripAnsi(output);
    assert.ok(stripped.includes('@@@ abc 2-2 HEAD="old"'));
    // Header lines pass through styleText("cyan", ...) which is TTY-aware,
    // so we just verify the formatter wraps it the same way.
    const headerStyled = styleText("cyan", '@@@ abc 2-2 HEAD="old"');
    assert.ok(output.includes(headerStyled));
  });
});

describe("formatToolUse (read_file)", () => {
  it("renders filePath alone when no offset/limit set", async () => {
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "r1",
      toolName: "read_file",
      input: { filePath: "src/app.mjs" },
    });
    assert.equal(output, "tool: read_file\nfilePath: src/app.mjs");
  });

  it("includes offset and limit when provided", async () => {
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "r2",
      toolName: "read_file",
      input: { filePath: "src/app.mjs", offset: 10, limit: 50 },
    });
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
