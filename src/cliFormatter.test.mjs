import assert from "node:assert";
import { describe, it } from "node:test";
import { styleText } from "node:util";
import { formatArgs, formatToolUse } from "./cliFormatter.mjs";

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
  it("formats a single search/replace diff pair", async () => {
    const diff =
      "<<< abc <<< SEARCH\nold line\n=== abc ===\nnew line\n>>> abc >>> REPLACE";

    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t4",
      toolName: "patch_file",
      input: { filePath: "src/app.mjs", diff },
    });

    assert.ok(output.startsWith("tool: patch_file\npath: src/app.mjs\n"));
    assert.ok(output.includes("diff --git"));
    assert.ok(
      output.includes("\x1b["),
      "Git diff should contain ANSI color codes",
    );
    assert.ok(output.includes("-------"));
    assert.ok(output.includes("new line"));
  });

  it("formats multiple search/replace diff", async () => {
    const diff = [
      "<<< a1a <<< SEARCH",
      "first old",
      "=== a1a ===",
      "first new",
      ">>> a1a >>> REPLACE",
      "<<< b2b <<< SEARCH",
      "second old",
      "=== b2b ===",
      "second new",
      ">>> b2b >>> REPLACE",
    ].join("\n");

    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t5",
      toolName: "patch_file",
      input: { filePath: "lib/mod.mjs", diff },
    });

    assert.ok(output.includes("first new"));
    assert.ok(output.includes("second new"));
    assert.ok(output.includes("diff --git"));
    const separatorCount = output.split("-------").length - 1;
    assert.equal(separatorCount, 2);
  });

  it("shows plain fallback when git diff returns null", async () => {
    const diff =
      "<<< abc <<< SEARCH\nold line\n=== abc ===\nnew line\n>>> abc >>> REPLACE";

    const output = await formatToolUse(
      {
        type: "tool_use",
        toolUseId: "t6",
        toolName: "patch_file",
        input: { filePath: "src/app.mjs", diff },
      },
      { createDiff: async () => null },
    );

    assert.equal(
      output,
      [
        "tool: patch_file",
        "path: src/app.mjs",
        `diff:\n${styleText("yellow", "(git diff unavailable, showing plain diff)")}\n--- old\nold line\n+++ new\nnew line`,
      ].join("\n"),
    );
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

  it("falls back when git diff returns empty string (identical content)", async () => {
    const diff =
      "<<< abc <<< SEARCH\nsame\n=== abc ===\nsame\n>>> abc >>> REPLACE";

    const output = await formatToolUse(
      {
        type: "tool_use",
        toolUseId: "t9",
        toolName: "patch_file",
        input: { filePath: "same.txt", diff },
      },
      { createDiff: async () => "" },
    );

    assert.ok(
      output.includes(
        styleText("yellow", "(git diff unavailable, showing plain diff)"),
      ),
      "Identical content should trigger fallback because empty git diff is falsy",
    );
  });
});
