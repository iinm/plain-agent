import assert from "node:assert";
import { describe, it } from "node:test";
import { createInterruptTransform } from "./cliInterruptTransform.mjs";

/**
 * @param {import("node:stream").Transform} transform
 * @param {string[]} chunks
 * @returns {Promise<string>}
 */
async function feedChunks(transform, chunks) {
  /** @type {Buffer[]} */
  const output = [];
  transform.on("data", (chunk) => {
    output.push(Buffer.from(chunk));
  });

  for (const chunk of chunks) {
    transform.write(chunk);
  }

  transform.end();
  await new Promise((resolve) => setImmediate(resolve));
  return Buffer.concat(output).toString("utf8");
}

describe("createInterruptTransform", () => {
  it("passes normal input through unchanged", async () => {
    const transform = createInterruptTransform({
      onCtrlC: () => {},
      onCtrlD: () => {},
    });
    const out = await feedChunks(transform, ["hello world\n"]);
    assert.strictEqual(out, "hello world\n");
  });

  it("invokes onCtrlC on Ctrl-C and drops the chunk", async () => {
    let ctrlC = 0;
    let ctrlD = 0;
    const transform = createInterruptTransform({
      onCtrlC: () => {
        ctrlC += 1;
      },
      onCtrlD: () => {
        ctrlD += 1;
      },
    });
    const out = await feedChunks(transform, ["\x03"]);
    assert.strictEqual(ctrlC, 1);
    assert.strictEqual(ctrlD, 0);
    assert.strictEqual(out, "");
  });

  it("invokes onCtrlD on Ctrl-D and drops the chunk", async () => {
    let ctrlC = 0;
    let ctrlD = 0;
    const transform = createInterruptTransform({
      onCtrlC: () => {
        ctrlC += 1;
      },
      onCtrlD: () => {
        ctrlD += 1;
      },
    });
    const out = await feedChunks(transform, ["\x04"]);
    assert.strictEqual(ctrlC, 0);
    assert.strictEqual(ctrlD, 1);
    assert.strictEqual(out, "");
  });

  it("prefers Ctrl-C over Ctrl-D when both are in the same chunk", async () => {
    let ctrlC = 0;
    let ctrlD = 0;
    const transform = createInterruptTransform({
      onCtrlC: () => {
        ctrlC += 1;
      },
      onCtrlD: () => {
        ctrlD += 1;
      },
    });
    const out = await feedChunks(transform, ["\x03\x04"]);
    assert.strictEqual(ctrlC, 1);
    assert.strictEqual(ctrlD, 0);
    assert.strictEqual(out, "");
  });

  it("invokes onVoiceToggle on the default byte (Ctrl-G) and drops the chunk", async () => {
    let toggled = 0;
    const transform = createInterruptTransform({
      onCtrlC: () => {},
      onCtrlD: () => {},
      onVoiceToggle: () => {
        toggled += 1;
      },
    });
    const out = await feedChunks(transform, ["\x07"]);
    assert.strictEqual(toggled, 1);
    assert.strictEqual(out, "");
  });

  it("respects a custom voiceToggleByte", async () => {
    let toggled = 0;
    const transform = createInterruptTransform({
      onCtrlC: () => {},
      onCtrlD: () => {},
      onVoiceToggle: () => {
        toggled += 1;
      },
      voiceToggleByte: 0x0f, // Ctrl-O
    });
    // Default Ctrl-G should now pass through unchanged
    const passThrough = await feedChunks(
      createInterruptTransform({
        onCtrlC: () => {},
        onCtrlD: () => {},
        onVoiceToggle: () => {
          assert.fail("should not be called");
        },
        voiceToggleByte: 0x0f,
      }),
      ["\x07"],
    );
    assert.strictEqual(passThrough, "\x07");

    const out = await feedChunks(transform, ["\x0f"]);
    assert.strictEqual(toggled, 1);
    assert.strictEqual(out, "");
  });

  it("passes the voice toggle byte through when no onVoiceToggle is provided", async () => {
    const transform = createInterruptTransform({
      onCtrlC: () => {},
      onCtrlD: () => {},
    });
    const out = await feedChunks(transform, ["\x07"]);
    assert.strictEqual(out, "\x07");
  });

  it("prefers Ctrl-C over the voice toggle when both are in the same chunk", async () => {
    let ctrlC = 0;
    let toggled = 0;
    const transform = createInterruptTransform({
      onCtrlC: () => {
        ctrlC += 1;
      },
      onCtrlD: () => {},
      onVoiceToggle: () => {
        toggled += 1;
      },
    });
    const out = await feedChunks(transform, ["\x03\x07"]);
    assert.strictEqual(ctrlC, 1);
    assert.strictEqual(toggled, 0);
    assert.strictEqual(out, "");
  });

  it("swallows non-handled chunks when shouldSwallowOthers returns true", async () => {
    let swallow = true;
    const transform = createInterruptTransform({
      onCtrlC: () => {},
      onCtrlD: () => {},
      shouldSwallowOthers: () => swallow,
    });
    const out = await feedChunks(transform, ["abc", "def"]);
    assert.strictEqual(out, "");
    swallow = false;
  });

  it("still invokes handlers when shouldSwallowOthers is true", async () => {
    let ctrlC = 0;
    let toggled = 0;
    const transform = createInterruptTransform({
      onCtrlC: () => {
        ctrlC += 1;
      },
      onCtrlD: () => {},
      onVoiceToggle: () => {
        toggled += 1;
      },
      shouldSwallowOthers: () => true,
    });
    const out = await feedChunks(transform, ["a", "\x07", "\x03"]);
    assert.strictEqual(ctrlC, 1);
    assert.strictEqual(toggled, 1);
    assert.strictEqual(out, "");
  });

  it("passes data through when shouldSwallowOthers returns false", async () => {
    const transform = createInterruptTransform({
      onCtrlC: () => {},
      onCtrlD: () => {},
      shouldSwallowOthers: () => false,
    });
    const out = await feedChunks(transform, ["hello"]);
    assert.strictEqual(out, "hello");
  });
});
