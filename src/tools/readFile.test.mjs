import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { lineHash } from "../utils/lineHash.mjs";
import { readFileTool } from "./readFile.mjs";

describe("readFileTool", () => {
  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];

  const generateRandomString = () => Math.random().toString(36).substring(2);

  afterEach(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  it("reads the whole file with line numbers and hashes", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = ["alpha", "bravo", "charlie"].join("\n");
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then:
    assert.equal(
      result,
      [
        `1:${lineHash("alpha")}|alpha`,
        `2:${lineHash("bravo")}|bravo`,
        `3:${lineHash("charlie")}|charlie`,
      ].join("\n"),
    );
  });

  it("preserves the trailing newline by dropping the empty last element", async () => {
    // given: file ends with newline
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "alpha\nbravo\n");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then: only 2 numbered lines, not 3
    assert.equal(
      result,
      [`1:${lineHash("alpha")}|alpha`, `2:${lineHash("bravo")}|bravo`].join(
        "\n",
      ),
    );
  });

  it("respects offset and limit", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      offset: 3,
      limit: 4,
    });

    // then:
    const expected = ["line 3", "line 4", "line 5", "line 6"]
      .map((l, i) => `${3 + i}:${lineHash(l)}|${l}`)
      .join("\n");
    assert.equal(result, expected);
  });

  it("right-aligns line numbers with hashes", async () => {
    // given: 10+ lines so line numbers need 2-digit padding
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then: line 1 should be right-aligned to width 2
    assert.ok(typeof result === "string");
    const resultLines = result.split("\n");
    assert.match(resultLines[0], /^ 1:/);
    assert.match(resultLines[9], /^10:/);
  });

  it("returns empty string for empty file", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then:
    assert.equal(result, "");
  });

  it("errors for non-existent file", async () => {
    // when:
    const result = await readFileTool.impl({
      filePath: "/no/such/file/readFileTest.txt",
    });

    // then:
    assert.ok(result instanceof Error);
  });

  it("errors when offset is out of range", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "alpha\nbravo\ncharlie");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when: offset past end of file
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      offset: 99,
    });

    // then:
    assert.equal(result, "");
  });

  it("errors when offset is not a positive integer", async () => {
    // when:
    const result = await readFileTool.impl({
      filePath: "/dummy",
      offset: 0,
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /offset must be a positive integer/);
  });

  it("errors when limit is not a positive integer", async () => {
    // when:
    const result = await readFileTool.impl({
      filePath: "/dummy",
      limit: -1,
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /limit must be a positive integer/);
  });

  it("shows hash for blank and whitespace-only lines", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "alpha\n\n   \ncharlie");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then:
    assert.ok(typeof result === "string");
    const resultLines = result.split("\n");
    assert.equal(resultLines.length, 4);
    assert.equal(resultLines[0], `1:${lineHash("alpha")}|alpha`);
    assert.equal(resultLines[1], `2:${lineHash("")}|`);
    assert.equal(resultLines[2], `3:${lineHash("   ")}|   `);
    assert.equal(resultLines[3], `4:${lineHash("charlie")}|charlie`);
  });

  it("truncates output when it exceeds the byte cap", async () => {
    // given: a file whose full content would exceed 8KB.
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const filler = "x".repeat(95);
    const lines = Array.from({ length: 200 }, (_, i) => `${filler}${i}`);
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then:
    assert.ok(result instanceof Error);
    const err = /** @type {Error} */ (result);
    assert.match(err.message, /exceed 8192 characters/);
    assert.match(err.message, /limit=\d+/);
    assert.match(err.message, /offset=\d+/);
  });

  it("returns the requested window when an explicit limit keeps output under the cap", async () => {
    // given: a huge file but the caller asks for only a few lines.
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const filler = "x".repeat(200);
    const lines = Array.from({ length: 1000 }, (_, i) => `${filler}${i}`);
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      offset: 10,
      limit: 5,
    });

    // then:
    assert.ok(typeof result === "string");
    const out = /** @type {string} */ (result);
    const outLines = out.split("\n");
    assert.equal(outLines.length, 5);
    assert.match(outLines[0], /^10:/);
    assert.match(outLines[4], /^14:/);
  });

  it("errors when the very first line alone exceeds the byte cap", async () => {
    // given: a single line larger than 8KB.
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "x".repeat(10_000));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then:
    assert.ok(result instanceof Error);
    assert.match(
      /** @type {Error} */ (result).message,
      /that line alone is too large/,
    );
  });
});
