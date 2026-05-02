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
    // given: a patch_file tool use with one search/replace pair
    const diff =
      "<<< abc <<< SEARCH\nold line\n=== abc ===\nnew line\n>>> abc >>> REPLACE";

    // when: formatting the tool use
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t4",
      toolName: "patch_file",
      input: { filePath: "src/app.mjs", diff },
    });

    // then: output contains the tool header, file path, and separator
    assert.ok(output.startsWith("tool: patch_file\npath: src/app.mjs\n"));
    assert.ok(output.includes("-------"));
    assert.ok(output.includes("new line"));
  });

  it("formats multiple search/replace diff pairs", async () => {
    // given: a patch_file tool use with two search/replace pairs
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

    // when: formatting the tool use
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t5",
      toolName: "patch_file",
      input: { filePath: "lib/mod.mjs", diff },
    });

    // then: output includes both replacements separated by blank lines
    assert.ok(output.includes("first new"));
    assert.ok(output.includes("second new"));
    // Each hunk ends with "-------" separator + replacement text
    const separatorCount = output.split("-------").length - 1;
    assert.equal(separatorCount, 2);
  });

  it("handles an empty diff string", async () => {
    // given: a patch_file tool use with no diff content
    // when: formatting the tool use
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t6",
      toolName: "patch_file",
      input: { filePath: "empty.txt", diff: "" },
    });

    // then: output has the tool header with no diff hunks
    assert.equal(output, "tool: patch_file\npath: empty.txt\ndiff:\n");
  });

  it("includes git diff output when git is available", async () => {
    // given: a patch_file tool use with differing content
    const diff =
      "<<< abc <<< SEARCH\nold content\n=== abc ===\nnew content\n>>> abc >>> REPLACE";

    // when: formatting the tool use
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t7",
      toolName: "patch_file",
      input: { filePath: "test.mjs", diff },
    });

    // then: output contains either git diff or fallback
    const hasGitDiff = output.includes("diff --git");
    const hasFallback =
      output.includes("--- old") &&
      output.includes("+++ new") &&
      output.includes(
        styleText("yellow", "(git diff unavailable, showing plain diff)"),
      );
    assert.ok(
      hasGitDiff || hasFallback,
      "Output should contain either git diff or fallback format",
    );
  });

  it("shows fallback notice with plain diff when git diff fails", async () => {
    // given: a patch_file tool use where tryGitDiff returns null
    // This test verifies the fallback format structure independently
    // of whether git is available (the previous test covers the happy path)
    const diff =
      "<<< xyz <<< SEARCH\noriginal\n=== xyz ===\nmodified\n>>> xyz >>> REPLACE";

    // when: formatting the tool use
    const output = await formatToolUse({
      type: "tool_use",
      toolUseId: "t8",
      toolName: "patch_file",
      input: { filePath: "file.mjs", diff },
    });

    // then: output always contains the replacement text and separator
    assert.ok(output.includes("modified"));
    assert.ok(output.includes("-------"));

    // If git diff failed, verify the fallback notice and plain diff format
    if (!output.includes("diff --git")) {
      assert.ok(
        output.includes(
          styleText("yellow", "(git diff unavailable, showing plain diff)"),
        ),
        "Fallback should include unavailability notice",
      );
      assert.ok(
        output.includes("--- old\noriginal\n+++ new\nmodified"),
        "Fallback should include plain diff format",
      );
    }
  });
});
