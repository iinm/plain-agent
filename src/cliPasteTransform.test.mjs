import assert from "node:assert";
import { describe, it } from "node:test";
import {
  createPasteTransform,
  resolvePastePlaceholders,
} from "./cliPasteTransform.mjs";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Feed chunks sequentially to the transform and collect the output.
 * Awaits on each write so that timers scheduled between chunks have a chance
 * to fire only when we intend them to (i.e. after the final chunk).
 * @param {import("node:stream").Transform} transform
 * @param {string[]} chunks
 * @param {{ chunkDelayMs?: number, finalWaitMs?: number }} [options]
 * @returns {Promise<string>}
 */
async function feedChunks(transform, chunks, options = {}) {
  const { chunkDelayMs = 0, finalWaitMs = 50 } = options;
  /** @type {Buffer[]} */
  const output = [];
  transform.on("data", (chunk) => {
    output.push(Buffer.from(chunk));
  });

  for (const chunk of chunks) {
    transform.write(chunk);
    if (chunkDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
    }
  }

  // Wait long enough for any pending merge timer to fire.
  await new Promise((resolve) => setTimeout(resolve, finalWaitMs));

  transform.end();
  // Allow any flush() callback to run.
  await new Promise((resolve) => setImmediate(resolve));

  return Buffer.concat(output).toString("utf8");
}

describe("createPasteTransform", () => {
  it("passes through normal typed input untouched", async () => {
    const transform = createPasteTransform(() => {});
    const out = await feedChunks(transform, ["hello world\n"]);
    assert.strictEqual(out, "hello world\n");
  });

  it("emits single-line paste content directly without placeholder", async () => {
    const transform = createPasteTransform(() => {});
    const out = await feedChunks(transform, [
      `${BRACKETED_PASTE_START}hello${BRACKETED_PASTE_END}`,
    ]);
    assert.strictEqual(out, "hello");
  });

  it("emits a placeholder for multi-line paste", async () => {
    const transform = createPasteTransform(() => {});
    const out = await feedChunks(transform, [
      `${BRACKETED_PASTE_START}line1\nline2\nline3${BRACKETED_PASTE_END}`,
    ]);
    assert.match(out, /^\[Pasted text #[a-f0-9]{6}, 3 lines\]$/);
  });

  it("merges two bracketed paste sequences that arrive in the same chunk", async () => {
    const transform = createPasteTransform(() => {});
    const out = await feedChunks(transform, [
      `${BRACKETED_PASTE_START}line1\nline2\n${BRACKETED_PASTE_END}${BRACKETED_PASTE_START}line3\nline4${BRACKETED_PASTE_END}`,
    ]);
    // Should produce a single placeholder, not two blocks.
    assert.match(out, /^\[Pasted text #[a-f0-9]{6}, 4 lines\]$/);

    const resolved = resolvePastePlaceholders(out);
    assert.ok(resolved.includes("line1\nline2\nline3\nline4"));
  });

  it("merges two bracketed paste sequences that arrive in separate chunks", async () => {
    const transform = createPasteTransform(() => {});
    const out = await feedChunks(
      transform,
      [
        `${BRACKETED_PASTE_START}line1\nline2\n${BRACKETED_PASTE_END}`,
        `${BRACKETED_PASTE_START}line3\nline4${BRACKETED_PASTE_END}`,
      ],
      { chunkDelayMs: 1 },
    );
    assert.match(out, /^\[Pasted text #[a-f0-9]{6}, 4 lines\]$/);

    const resolved = resolvePastePlaceholders(out);
    assert.ok(resolved.includes("line1\nline2\nline3\nline4"));
  });

  it("does not merge pastes separated by a longer gap than the merge window", async () => {
    const transform = createPasteTransform(() => {});
    const out = await feedChunks(
      transform,
      [
        `${BRACKETED_PASTE_START}line1\nline2${BRACKETED_PASTE_END}`,
        `${BRACKETED_PASTE_START}line3\nline4${BRACKETED_PASTE_END}`,
      ],
      { chunkDelayMs: 100 },
    );
    // Two separate placeholders.
    const matches = out.match(/\[Pasted text #[a-f0-9]{6}, 2 lines\]/g);
    assert.ok(matches);
    assert.strictEqual(matches.length, 2);
  });

  it("continues a paste split across multiple chunks without an end marker", async () => {
    const transform = createPasteTransform(() => {});
    const out = await feedChunks(
      transform,
      [
        `${BRACKETED_PASTE_START}line1\nline2\n`,
        "line3\nline4\n",
        `line5${BRACKETED_PASTE_END}`,
      ],
      { chunkDelayMs: 1 },
    );
    assert.match(out, /^\[Pasted text #[a-f0-9]{6}, 5 lines\]$/);
  });

  it("flushes pending paste when typing resumes after a paste", async () => {
    const transform = createPasteTransform(() => {});
    const out = await feedChunks(
      transform,
      [`${BRACKETED_PASTE_START}line1\nline2${BRACKETED_PASTE_END}`, "\n"],
      { chunkDelayMs: 1 },
    );
    // Placeholder emitted, followed by the newline typed by the user.
    assert.match(out, /^\[Pasted text #[a-f0-9]{6}, 2 lines\]\n$/);
  });

  it("invokes onCtrlC on Ctrl-C", async () => {
    let called = 0;
    const transform = createPasteTransform(() => {
      called += 1;
    });
    await feedChunks(transform, ["\x03"]);
    assert.strictEqual(called, 1);
  });

  it("invokes onCtrlC on Ctrl-D", async () => {
    let called = 0;
    const transform = createPasteTransform(() => {
      called += 1;
    });
    await feedChunks(transform, ["\x04"]);
    assert.strictEqual(called, 1);
  });
});

describe("resolvePastePlaceholders", () => {
  it("appends a context tag for each referenced paste", async () => {
    const transform = createPasteTransform(() => {});
    const out = await feedChunks(transform, [
      `${BRACKETED_PASTE_START}alpha\nbeta\ngamma${BRACKETED_PASTE_END}`,
    ]);
    // out is the placeholder; feed it back through resolvePastePlaceholders.
    const resolved = resolvePastePlaceholders(out);
    assert.match(resolved, /\[Pasted text #[a-f0-9]{6}, 3 lines\]/);
    assert.match(
      resolved,
      /<context id="pasted#[a-f0-9]{6}">\nalpha\nbeta\ngamma\n<\/context>/,
    );
  });

  it("returns input unchanged when there are no placeholders", () => {
    assert.strictEqual(resolvePastePlaceholders("just text"), "just text");
  });
});
