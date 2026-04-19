import assert from "node:assert";
import { describe, it } from "node:test";
import { createMuteTransform } from "./cliMuteTransform.mjs";

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

describe("createMuteTransform", () => {
  it("passes chunks through when isMuted returns false", async () => {
    const transform = createMuteTransform({ isMuted: () => false });
    const out = await feedChunks(transform, ["hello", " world"]);
    assert.strictEqual(out, "hello world");
  });

  it("drops all chunks when isMuted returns true", async () => {
    const transform = createMuteTransform({ isMuted: () => true });
    const out = await feedChunks(transform, ["hello", " world"]);
    assert.strictEqual(out, "");
  });

  it("switches from muted to unmuted mid-stream", async () => {
    let muted = true;
    const transform = createMuteTransform({ isMuted: () => muted });

    /** @type {Buffer[]} */
    const output = [];
    transform.on("data", (chunk) => output.push(Buffer.from(chunk)));

    transform.write("dropped");
    muted = false;
    transform.write("passed");
    transform.end();

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(Buffer.concat(output).toString("utf8"), "passed");
  });

  it("switches from unmuted to muted mid-stream", async () => {
    let muted = false;
    const transform = createMuteTransform({ isMuted: () => muted });

    /** @type {Buffer[]} */
    const output = [];
    transform.on("data", (chunk) => output.push(Buffer.from(chunk)));

    transform.write("passed");
    muted = true;
    transform.write("dropped");
    transform.end();

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(Buffer.concat(output).toString("utf8"), "passed");
  });
});
