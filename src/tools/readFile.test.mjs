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

    // then: width is based on the largest emitted line (6), not the
    // file's total line count, since we stop streaming early.
    assert.equal(
      result,
      ["3\tline 3", "4\tline 4", "5\tline 5", "6\tline 6"].join("\n"),
    );
  });

  it("pads numbers to the largest emitted line within a single call", async () => {
    // given: a file long enough that an offset/limit window crosses the
    // 9 -> 10 width boundary, so padding must be 2 chars to keep the
    // column aligned in this response.
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      offset: 8,
      limit: 4,
    });

    // then: width is 2 because the largest emitted line number is 11.
    assert.equal(
      result,
      [" 8\tline 8", " 9\tline 9", "10\tline 10", "11\tline 11"].join("\n"),
    );
  });

  it("does not load the entire file when limit is small (streams with early stop)", async () => {
    // given: a file far larger than the requested window.
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const totalLines = 50_000;
    const lines = Array.from({ length: totalLines }, (_, i) => `L${i + 1}`);
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const start = process.hrtime.bigint();
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      offset: 1,
      limit: 3,
    });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // then: we get exactly the first 3 lines, and we got them quickly
    // (a full-file read of 50k lines would still be fast on modern
    // hardware, so this is a soft sanity check rather than a strict
    // perf guarantee — the main correctness assertion is the output).
    assert.equal(result, ["1\tL1", "2\tL2", "3\tL3"].join("\n"));
    // Generous bound; the previous implementation would also be fast
    // here, so this just guards against pathological regressions.
    assert.ok(elapsedMs < 1000, `read_file too slow: ${elapsedMs}ms`);
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

  it("reads the whole file when no limit is given and output fits the byte cap", async () => {
    // given: a file that easily fits within 8KB.
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then: every line is returned with width=2 padding (max line is 50).
    assert.ok(typeof result === "string");
    const out = /** @type {string} */ (result);
    const outLines = out.split("\n");
    assert.equal(outLines.length, 50);
    assert.equal(outLines[0], " 1\tline 1");
    assert.equal(outLines[49], "50\tline 50");
  });

  it("errors with a chunking hint when output would exceed the byte cap", async () => {
    // given: a file whose full output is well past 8KB.
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    // Each line is ~100 bytes; 200 lines => ~20KB of formatted output.
    const filler = "x".repeat(95);
    const lines = Array.from({ length: 200 }, (_, i) => `${filler}${i}`);
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const result = await readFileTool.impl({ filePath: tmpFilePath });

    // then:
    assert.ok(result instanceof Error);
    const err = /** @type {Error} */ (result);
    assert.match(err.message, /exceed 8192 bytes/);
    assert.match(err.message, /limit=\d+/);
    assert.match(err.message, /offset=\d+/);
  });

  it("errors when an explicit limit still produces output past the byte cap", async () => {
    // given:
    const tmpFilePath = `tmp/readFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const filler = "x".repeat(200);
    const lines = Array.from({ length: 100 }, (_, i) => `${filler}${i}`);
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when: ask for many lines that together exceed the cap.
    const result = await readFileTool.impl({
      filePath: tmpFilePath,
      limit: 100,
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(/** @type {Error} */ (result).message, /exceed 8192 bytes/);
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
    assert.match(outLines[0], /^10\t/);
    assert.match(outLines[4], /^14\t/);
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
