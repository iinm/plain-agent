import assert from "node:assert";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { loadUserMessageContext } from "./loadUserMessageContext.mjs";

const SOURCE_IMAGE_PATH = path.resolve("src/utils/test/iinm.png");
const TEMP_DIR = path.resolve("tmp/load-user-message-context");

describe("loadUserMessageContext", () => {
  after(async () => {
    await rm(TEMP_DIR, { recursive: true });
  });

  it("should convert escaped-space image references", async () => {
    // given:
    const { imagePath, imageData } = await prepareImage("sample image.png");
    const message = `@${imagePath.replace(" ", "\\ ")}`;

    // when:
    const result = await loadUserMessageContext(message);

    // then:
    assert.deepStrictEqual(result, [
      {
        text: `[Image #1:${imagePath}]`,
        type: "text",
      },
      {
        data: imageData,
        mimeType: "image/png",
        type: "image",
      },
    ]);
  });

  it("should convert quoted image references", async () => {
    // given:
    const { imagePath, imageData } = await prepareImage("quoted image.png");
    const message = `@'${imagePath}'`;

    // when:
    const result = await loadUserMessageContext(message);

    // then:
    assert.deepStrictEqual(result, [
      {
        text: `[Image #1:${imagePath}]`,
        type: "text",
      },
      {
        data: imageData,
        mimeType: "image/png",
        type: "image",
      },
    ]);
  });

  it("should convert inline image references", async () => {
    // given:
    const { imagePath, imageData } = await prepareImage("inline image.png");
    const message = `before @'${imagePath}' after`;

    // when:
    const result = await loadUserMessageContext(message);

    // then:
    assert.deepStrictEqual(result, [
      {
        text: `before [Image #1:${imagePath}] after`,
        type: "text",
      },
      {
        data: imageData,
        mimeType: "image/png",
        type: "image",
      },
    ]);
  });

  it("should preserve file contexts alongside image references", async () => {
    // given:
    const { imagePath, imageData } = await prepareImage("context image.png");
    const message = [
      "first line",
      "before-README @README.md:1 after-README",
      "middle of text and image",
      `before-image @${imagePath.replace(" ", "\\ ")} after-image`,
      "last line",
    ].join("\n");

    // when:
    const result = await loadUserMessageContext(message);

    // then:
    assert.deepStrictEqual(result, [
      {
        text: [
          "first line",
          "before-README @README.md:1 after-README",
          "middle of text and image",
          `before-image [Image #1:${imagePath}] after-image`,
          "last line",
          "",
          '<context location="README.md:1">',
          "# Plain Agent",
          "</context>",
        ].join("\n"),
        type: "text",
      },
      {
        data: imageData,
        mimeType: "image/png",
        type: "image",
      },
    ]);
  });

  it("rejects text references whose symlink target is outside the working directory", async (t) => {
    // given:
    await mkdir(TEMP_DIR, { recursive: true });
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "plain-agent-reference-"),
    );
    t.after(() => rm(outsideDir, { recursive: true, force: true }));
    const outsideFile = path.join(outsideDir, "notes.txt");
    const link = path.join(TEMP_DIR, "outside.txt");
    await writeFile(outsideFile, "outside text");
    await symlink(outsideFile, link);
    const message = `@'${link}'`;

    // when:
    const result = await loadUserMessageContext(message);

    // then:
    assert.deepStrictEqual(result, [{ type: "text", text: message }]);
  });

  it("reads text references and symlinks inside the working directory", async () => {
    // given:
    const fixture = await mkdtemp(path.join(process.cwd(), "..context-"));
    try {
      const notes = path.join(fixture, "notes.txt");
      const link = path.join(fixture, "inside.txt");
      await writeFile(notes, "first line\nsecond line\n");
      await symlink(notes, link);

      for (const filePath of [notes, link]) {
        const reference = `${filePath}:2`;
        const message = `@'${reference}'`;

        // when:
        const result = await loadUserMessageContext(message);

        // then:
        assert.deepStrictEqual(result, [
          {
            type: "text",
            text: `${message}\n\n<context location="${reference}">\nsecond line\n</context>`,
          },
        ]);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("should not attach an image whose content does not match its extension", async () => {
    // given:
    await mkdir(TEMP_DIR, { recursive: true });
    const filePath = path.join(TEMP_DIR, "mismatch.png");
    await writeFile(filePath, "this is not an image");

    // when:
    const result = await loadUserMessageContext(`@${filePath}`);

    // then: the reference stays plain text and no image part is produced
    assert.deepStrictEqual(result, [{ text: `@${filePath}`, type: "text" }]);
  });
});

/**
 * @param {string} fileName
 * @returns {Promise<{imagePath: string, imageData: string}>}
 */
async function prepareImage(fileName) {
  await mkdir(TEMP_DIR, { recursive: true });
  const imagePath = path.join(TEMP_DIR, fileName);
  await copyFile(SOURCE_IMAGE_PATH, imagePath);
  const imageData = await readFile(imagePath, { encoding: "base64" });

  return { imagePath, imageData };
}
