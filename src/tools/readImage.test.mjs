import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { readImageTool } from "./readImage.mjs";

const SAMPLE_IMAGE_PATH = "src/utils/test/iinm.png";

describe("readImageTool", () => {
  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];

  const generateRandomString = () => Math.random().toString(36).substring(2);

  afterEach(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  it("returns the image as base64 with its MIME type", async () => {
    // given:
    const expected = await fs.readFile(SAMPLE_IMAGE_PATH);

    // when:
    const result = await readImageTool.impl({ filePath: SAMPLE_IMAGE_PATH });

    // then:
    assert.ok(Array.isArray(result));
    const parts = asImageParts(result);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, "image");
    assert.equal(parts[0].mimeType, "image/png");
    assert.deepEqual(Buffer.from(parts[0].data, "base64"), expected);
  });

  it("infers the MIME type from a case-insensitive extension", async () => {
    // given:
    const tmpFilePath = `tmp/readImageTest-${generateRandomString()}.PNG`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.copyFile(SAMPLE_IMAGE_PATH, tmpFilePath);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readImageTool.impl({ filePath: tmpFilePath });

    // then:
    assert.ok(Array.isArray(result));
    assert.equal(asImageParts(result)[0].mimeType, "image/png");
  });

  it("rejects a non-image file that has an image extension", async () => {
    // given:
    const tmpFilePath = `tmp/readImageTest-${generateRandomString()}.png`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "this is not an image");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readImageTool.impl({ filePath: tmpFilePath });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /declares image\/png by its extension/);
    assert.match(result.message, /the content is not PNG, JPEG, GIF, or WebP/);
  });

  it("rejects an image whose type differs from its extension", async () => {
    // given: PNG data with a .jpg extension.
    const tmpFilePath = `tmp/readImageTest-${generateRandomString()}.jpg`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.copyFile(SAMPLE_IMAGE_PATH, tmpFilePath);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readImageTool.impl({ filePath: tmpFilePath });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /declares image\/jpeg by its extension/);
    assert.match(result.message, /the content is image\/png/);
  });

  it("errors for an unsupported extension", async () => {
    // when:
    const result = await readImageTool.impl({ filePath: "tmp/notes.txt" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Unsupported image file/);
  });

  it("errors for a non-existent file", async () => {
    // when:
    const result = await readImageTool.impl({
      filePath: "/no/such/file/readImageTest.png",
    });

    // then:
    assert.ok(result instanceof Error);
  });

  it("errors when the image exceeds the size limit", async () => {
    // given: 2 MB + 1 byte, just over the limit.
    const tmpFilePath = `tmp/readImageTest-${generateRandomString()}.png`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, Buffer.alloc(2 * 1024 * 1024 + 1));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readImageTool.impl({ filePath: tmpFilePath });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Image is 2\.0 MB/);
    assert.match(result.message, /over the 2 MB limit/);
  });
});

/**
 * @param {import("../tool").StructuredToolResultContent[] | string | Error} result
 * @returns {{ type: string; data: string; mimeType: string }[]}
 */
function asImageParts(result) {
  return /** @type {{ type: string; data: string; mimeType: string }[]} */ (
    result
  );
}
