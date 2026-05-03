import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
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

  it("reads the whole file with right-aligned line numbers", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = ["alpha", "bravo", "charlie"].join("\n");
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then:
    assert.equal(result, ["1\talpha", "2\tbravo", "3\tcharlie"].join("\n"));
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
    assert.equal(result, ["1\talpha", "2\tbravo"].join("\n"));
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

    // then: width is 2 because total line count is 12
    assert.equal(
      result,
      [" 3\tline 3", " 4\tline 4", " 5\tline 5", " 6\tline 6"].join("\n"),
    );
  });

  it("returns empty string when offset is past EOF", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "only one line\n");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      offset: 100,
    });

    // then:
    assert.equal(result, "");
  });

  it("clamps limit to remaining lines", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, ["a", "b", "c"].join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      offset: 2,
      limit: 1000,
    });

    // then:
    assert.equal(result, ["2\tb", "3\tc"].join("\n"));
  });

  it("rejects non-positive offset", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "hi");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      offset: 0,
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /offset/);
  });

  it("rejects non-positive limit", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "hi");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      limit: 0,
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /limit/);
  });

  it("returns Error when file is missing", async () => {
    // when:
    const result = await readFileTool.impl({
      filePath: "tmp/does-not-exist.txt",
    });

    // then:
    assert.ok(result instanceof Error);
  });
});
