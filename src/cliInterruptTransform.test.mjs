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
    const transform = createInterruptTransform(() => {});
    const out = await feedChunks(transform, ["hello world\n"]);
    assert.strictEqual(out, "hello world\n");
  });

  it("invokes onInterrupt on Ctrl-C and drops the chunk", async () => {
    let called = 0;
    const transform = createInterruptTransform(() => {
      called += 1;
    });
    const out = await feedChunks(transform, ["\x03"]);
    assert.strictEqual(called, 1);
    assert.strictEqual(out, "");
  });

  it("invokes onInterrupt on Ctrl-D and drops the chunk", async () => {
    let called = 0;
    const transform = createInterruptTransform(() => {
      called += 1;
    });
    const out = await feedChunks(transform, ["\x04"]);
    assert.strictEqual(called, 1);
    assert.strictEqual(out, "");
  });
});
