import assert from "node:assert";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { createLineEditor } from "./lineEditor.mjs";

/**
 * Create a fresh editor with PassThrough streams for testing.
 * @param {Partial<import("./lineEditor.mjs").LineEditorOptions>} [overrides]
 */
function setup(overrides = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  /** @type {string[]} */
  const lines = [];
  let closeCalled = false;
  /** @type {import("./lineEditor.mjs").TabContext[]} */
  const tabCalls = [];

  const editor = createLineEditor({
    input,
    output,
    prompt: "> ",
    onLine: (line) => lines.push(line),
    onClose: () => {
      closeCalled = true;
    },
    onTab: (ctx) => tabCalls.push(ctx),
    ...overrides,
  });

  /** Collect everything written to the output stream so far. */
  const readOutput = () => {
    /** @type {Buffer[]} */
    const bufs = [];
    for (;;) {
      const chunk = /** @type {Buffer | null} */ (output.read());
      if (chunk === null) break;
      bufs.push(chunk);
    }
    return Buffer.concat(bufs).toString("utf8");
  };

  return {
    input,
    output,
    editor,
    lines,
    tabCalls,
    isCloseCalled: () => closeCalled,
    readOutput,
  };
}

// ---------------------------------------------------------------------------
// Normal input
// ---------------------------------------------------------------------------

describe("createLineEditor – normal input", () => {
  it("calls onLine with typed text on Enter (\\r)", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("hello\r");

    // then:
    assert.deepStrictEqual(lines, ["hello"]);
    editor.close();
  });

  it("calls onLine with typed text on Enter (\\n)", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("world\n");

    // then:
    assert.deepStrictEqual(lines, ["world"]);
    editor.close();
  });

  it("handles multiple Enter presses in a single chunk", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("first\rsecond\r");

    // then:
    assert.deepStrictEqual(lines, ["first", "second"]);
    editor.close();
  });

  it("returns an empty string for Enter on an empty line", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("\r");

    // then:
    assert.deepStrictEqual(lines, [""]);
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// Backspace
// ---------------------------------------------------------------------------

describe("createLineEditor – backspace", () => {
  it("deletes the character before the cursor", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("abc\x7f\r"); // type abc, backspace, Enter

    // then:
    assert.deepStrictEqual(lines, ["ab"]);
    editor.close();
  });

  it("does nothing on empty line", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("\x7f\r");

    // then:
    assert.deepStrictEqual(lines, [""]);
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// Cursor movement
// ---------------------------------------------------------------------------

describe("createLineEditor – cursor movement", () => {
  it("arrow left + insert produces correct result", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:   type "ac", left, type "b", Enter → "abc"
    input.write("ac\x1b[Db\r");

    // then:
    assert.deepStrictEqual(lines, ["abc"]);
    editor.close();
  });

  it("arrow right after left restores cursor position", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:   type "ac", left, right, type "d", Enter → "acd"
    input.write("ac\x1b[D\x1b[Cd\r");

    // then:
    assert.deepStrictEqual(lines, ["acd"]);
    editor.close();
  });

  it("Home (\\x1b[H) moves cursor to start", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("bc\x1b[Ha\r");

    // then:
    assert.deepStrictEqual(lines, ["abc"]);
    editor.close();
  });

  it("End (\\x1b[F) moves cursor to end", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:   type "ac", Home, End, type "d", Enter → "acd"
    input.write("ac\x1b[H\x1b[Fd\r");

    // then:
    assert.deepStrictEqual(lines, ["acd"]);
    editor.close();
  });

  it("Ctrl-A moves cursor to start", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("bc\x01a\r"); // Ctrl-A = 0x01

    // then:
    assert.deepStrictEqual(lines, ["abc"]);
    editor.close();
  });

  it("Ctrl-E moves cursor to end", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:   type "ac", Ctrl-A, Ctrl-E, type "d"
    input.write("ac\x01\x05d\r"); // Ctrl-A then Ctrl-E

    // then:
    assert.deepStrictEqual(lines, ["acd"]);
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// Kill / delete operations
// ---------------------------------------------------------------------------

describe("createLineEditor – kill operations", () => {
  it("Ctrl-K kills to end of line", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:   type "abcd", left, left, Ctrl-K, Enter
    input.write("abcd\x1b[D\x1b[D\x0b\r");

    // then:
    assert.deepStrictEqual(lines, ["ab"]);
    editor.close();
  });

  it("Ctrl-U kills to start of line", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:   type "abcd", left, left, Ctrl-U, Enter
    input.write("abcd\x1b[D\x1b[D\x15\r");

    // then:
    assert.deepStrictEqual(lines, ["cd"]);
    editor.close();
  });

  it("Ctrl-W kills word backwards", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("hello world\x17\r"); // Ctrl-W = 0x17

    // then:
    assert.deepStrictEqual(lines, ["hello "]);
    editor.close();
  });

  it("Delete key (\\x1b[3~) removes character under cursor", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:   type "abc", Home, Delete, Enter → "bc"
    input.write("abc\x1b[H\x1b[3~\r");

    // then:
    assert.deepStrictEqual(lines, ["bc"]);
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// Multi-line (sequential Enter presses)
// ---------------------------------------------------------------------------

describe("createLineEditor – multi-line", () => {
  it("resets buffer after each Enter so successive lines are independent", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("line1\r");
    input.write("line2\r");

    // then:
    assert.deepStrictEqual(lines, ["line1", "line2"]);
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// Ctrl-C / Ctrl-D (bytes ignored by editor; handled upstream)
// ---------------------------------------------------------------------------

describe("createLineEditor – Ctrl-C / Ctrl-D bytes", () => {
  it("ignores Ctrl-C (0x03) without crashing", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("ab\x03cd\r");

    // then: 0x03 is a control char < 0x20 and not specifically handled → skipped
    assert.deepStrictEqual(lines, ["abcd"]);
    editor.close();
  });

  it("ignores Ctrl-D (0x04) without crashing", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("ab\x04cd\r");

    // then:
    assert.deepStrictEqual(lines, ["abcd"]);
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// Tab completion
// ---------------------------------------------------------------------------

describe("createLineEditor – Tab completion", () => {
  it("calls onTab with current editor state", () => {
    // given:
    const { input, tabCalls, editor } = setup();
    input.write("/hel");

    // when:
    input.write("\t");

    // then:
    assert.strictEqual(tabCalls.length, 1);
    assert.strictEqual(tabCalls[0].line, "/hel");
    assert.strictEqual(tabCalls[0].cursor, 4);
    assert.strictEqual(tabCalls[0].prompt, "> ");
    editor.close();
  });

  it("updateLine via TabContext updates editor state", () => {
    // given:
    const { input, lines, editor } = setup({
      onTab: (ctx) => {
        ctx.updateLine("/help");
      },
    });
    input.write("/hel");

    // when:
    input.write("\t");
    input.write("\r");

    // then:
    assert.deepStrictEqual(lines, ["/help"]);
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// Resize suppression
// ---------------------------------------------------------------------------

describe("createLineEditor – resize suppression", () => {
  it("does not redraw on resize when suppressRefresh is true", () => {
    // given:
    const input = new PassThrough();
    const output = new PassThrough();
    // Make output look like a TTY so the resize listener is attached
    Object.defineProperty(output, "isTTY", { value: true });
    Object.defineProperty(output, "columns", { value: 80 });

    const editor = createLineEditor({
      input,
      output,
      prompt: "> ",
      onLine: () => {},
      onClose: () => {},
    });

    // Render initial prompt to make the editor active
    editor.render();
    // Drain initial render output
    while (output.read()) {}

    // when:
    editor.setSuppressRefresh(true);
    output.emit("resize");

    // then: no new output written because refresh was suppressed
    const chunk = output.read();
    assert.strictEqual(chunk, null);
    editor.close();
  });

  it("redraws on resize when suppressRefresh is false", () => {
    // given:
    const input = new PassThrough();
    const output = new PassThrough();
    Object.defineProperty(output, "isTTY", { value: true });
    Object.defineProperty(output, "columns", { value: 80 });

    const editor = createLineEditor({
      input,
      output,
      prompt: "> ",
      onLine: () => {},
      onClose: () => {},
    });

    editor.render();
    while (output.read()) {}

    // Type something so the line is non-empty
    input.write("x");
    while (output.read()) {}

    // when:
    editor.setSuppressRefresh(false);
    output.emit("resize");

    // then: output should contain refreshed content
    const chunk = output.read();
    assert.ok(chunk !== null, "expected output after resize");
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// Bracketed paste recovery
// ---------------------------------------------------------------------------

describe("createLineEditor – bracketed paste recovery", () => {
  it("resumes normal editing after receiving pasted placeholder text", () => {
    // given:
    const { input, lines, editor } = setup();

    // Simulate pasted placeholder arriving from pasteTransform
    input.write("[Pasted text #abc123, 3 lines]");

    // when: user continues typing after paste
    input.write(" extra\r");

    // then:
    assert.deepStrictEqual(lines, ["[Pasted text #abc123, 3 lines] extra"]);
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// setPrompt / clearLine / getLine / getPrompt / render
// ---------------------------------------------------------------------------

describe("createLineEditor – API methods", () => {
  it("setPrompt + render redraws with new prompt", () => {
    // given:
    const { editor, readOutput } = setup();
    editor.render();
    readOutput(); // drain

    // when:
    editor.setPrompt("$ ");
    editor.render();
    const out = readOutput();

    // then: output contains the new prompt
    assert.ok(out.includes("$ "), `expected '$ ' in output, got: ${out}`);
    editor.close();
  });

  it("clearLine resets the input buffer", () => {
    // given:
    const { input, editor, lines } = setup();
    input.write("hello");

    // when:
    assert.strictEqual(editor.getLine(), "hello");
    editor.clearLine();

    // then:
    assert.strictEqual(editor.getLine(), "");
    input.write("\r");
    assert.deepStrictEqual(lines, [""]);
    editor.close();
  });

  it("getPrompt returns the current prompt", () => {
    // given:
    const { editor } = setup();

    // then:
    assert.strictEqual(editor.getPrompt(), "> ");
    editor.setPrompt("$ ");
    assert.strictEqual(editor.getPrompt(), "$ ");
    editor.close();
  });

  it("close removes listeners so further input is ignored", () => {
    // given:
    const { input, editor, lines } = setup();

    // when:
    editor.close();
    input.write("ignored\r");

    // then:
    assert.deepStrictEqual(lines, []);
  });
});

// ---------------------------------------------------------------------------
// onClose
// ---------------------------------------------------------------------------

describe("createLineEditor – onClose", () => {
  it("calls onClose when input stream ends", async () => {
    // given:
    const { input, isCloseCalled, editor } = setup();

    // when:
    input.end();
    await new Promise((resolve) => setImmediate(resolve));

    // then:
    assert.ok(isCloseCalled());
    editor.close();
  });
});

// ---------------------------------------------------------------------------
// Wide / multibyte characters
// ---------------------------------------------------------------------------

describe("createLineEditor – wide characters", () => {
  it("handles CJK characters correctly", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("日本語\r");

    // then:
    assert.deepStrictEqual(lines, ["日本語"]);
    editor.close();
  });

  it("backspace removes one CJK character", () => {
    // given:
    const { input, lines, editor } = setup();

    // when:
    input.write("日本語\x7f\r");

    // then:
    assert.deepStrictEqual(lines, ["日本"]);
    editor.close();
  });
});
