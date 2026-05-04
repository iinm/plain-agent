import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { createPatchFileTool } from "./patchFile.mjs";

describe("patchFileTool", () => {
  const patchFileTool = createPatchFileTool("012");

  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];

  const generateRandomString = () => Math.random().toString(36).substring(2);

  /**
   * @param {string[]} lines
   * @returns {Promise<string>}
   */
  const writeTmp = async (lines) => {
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, lines.join("\n"));
    cleanups.push(() => fs.unlink(tmpFilePath));
    return tmpFilePath;
  };

  afterEach(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  it("replaces a single line range", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      "Hello World",
      "This is a test file content 1.",
      "This is a test file content 2.",
      "This is a test file content 3.",
    ]);

    // when:
    const patch = `
@@@ 012 1-1
Hello Universe
@@@ 012

@@@ 012 3-4
This is a test file content updated 2.
This is a test file content updated 3.
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      [
        "Hello Universe",
        "This is a test file content 1.",
        "This is a test file content updated 2.",
        "This is a test file content updated 3.",
      ].join("\n"),
    );
  });

  it("deletes a range with an empty body", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      "Hello World",
      "drop me",
      "drop me too",
      "keep me",
    ]);

    // when:
    const patch = `
@@@ 012 2-3
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, ["Hello World", "keep me"].join("\n"));
  });

  it("inserts content with N+ syntax (after a line)", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo", "delta"]);

    // when: insert "charlie" after line 2
    const patch = `
@@@ 012 2+
charlie
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ["alpha", "bravo", "charlie", "delta"].join("\n"),
    );
  });

  it("prepends with 0+ and appends with {lastLine}+", async () => {
    // given:
    const tmpFilePath = await writeTmp(["middle"]);

    // when:
    const patch = `
@@@ 012 0+
top
@@@ 012

@@@ 012 1+
bottom
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, ["top", "middle", "bottom"].join("\n"));
  });

  it("inserts into an empty file with 0+ without spurious trailing newline", async () => {
    // given: an empty file (read_file would report 0 lines).
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const patch = `
@@@ 012 0+
new content
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, "new content");
  });

  it("rejects replace 1-1 on an empty file (no line 1 exists)", async () => {
    // given: an empty file.
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const patch = `
@@@ 012 1-1
new
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /extends past end of file \(0 lines\)/);
  });

  it("preserves trailing newline when present", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "alpha\nbravo\n");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const patch = `
@@@ 012 1-1
ALPHA
@@@ 012
`.trim();
    await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, "ALPHA\nbravo\n");
  });

  it("does not introduce trailing newline when original lacked one", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath, "alpha\nbravo");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const patch = `
@@@ 012 2-2
BRAVO
@@@ 012
`.trim();
    await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, "alpha\nBRAVO");
  });

  it("uses original line numbers across multiple blocks", async () => {
    // given:
    const tmpFilePath = await writeTmp(["one", "two", "three", "four", "five"]);

    // when: line numbers refer to ORIGINAL file even though block 1 changes line count
    const patch = `
@@@ 012 1-1
ONE
TWO
@@@ 012

@@@ 012 5-5
FIVE
@@@ 012
`.trim();
    await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ["ONE", "TWO", "two", "three", "four", "FIVE"].join("\n"),
    );
  });

  it("HEAD verification passes when first line matches (after trim)", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      "  export function foo() {",
      "    return 1;",
      "  }",
    ]);

    // when:
    const patch = `
@@@ 012 2-2 HEAD=return 1;
    return 42;
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ["  export function foo() {", "    return 42;", "  }"].join("\n"),
    );
  });

  it("HEAD verification accepts a prefix of the actual line (startsWith)", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      "export function foo(arg) {",
      "  return arg;",
      "}",
    ]);

    // when: HEAD specifies a prefix of the actual line, not the full text
    const patch = `
@@@ 012 1-1 HEAD=export function foo(
export function foo(arg, opts) {
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ["export function foo(arg, opts) {", "  return arg;", "}"].join("\n"),
    );
  });

  it("HEAD verification accepts unquoted values containing spaces and quotes", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      'const greeting = "hello world";',
      "console.log(greeting);",
    ]);

    // when:
    const patch = `
@@@ 012 1-1 HEAD=const greeting = "hello world";
const greeting = "Hello, World!";
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ['const greeting = "Hello, World!";', "console.log(greeting);"].join(
        "\n",
      ),
    );
  });

  it("HEAD verification fails when first line does not match", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo", "charlie"]);

    // when: HEAD claims "alpha" but actual line 2 is "bravo"
    const patch = `
@@@ 012 2-2 HEAD=alpha
new
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /HEAD verification failed at line 2/);
  });

  it("rejects empty HEAD= value", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha"]);

    // when:
    const patch = `
@@@ 012 1-1 HEAD=
new
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /HEAD= value is empty/);
  });

  it("rejects overlapping replace ranges", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b", "c", "d", "e"]);

    // when: ranges 2-3 and 3-4 overlap on line 3
    const patch = `
@@@ 012 2-3
X
@@@ 012

@@@ 012 3-4
Y
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Replace ranges overlap/);
  });

  it("rejects insert that falls inside a replace range", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b", "c", "d", "e"]);

    // when: insert at 3+ lies strictly inside replace [2-4]
    const patch = `
@@@ 012 2-4
X
@@@ 012

@@@ 012 3+
Y
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Insert at 3\+ falls inside replace range/);
  });

  it("allows insert at edges of a replace range", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b", "c", "d", "e"]);

    // when: insert at 1+ (just before replace 2-4) and insert at 4+ (just after)
    const patch = `
@@@ 012 2-4
X
@@@ 012

@@@ 012 1+
before
@@@ 012

@@@ 012 4+
after
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, ["a", "before", "X", "after", "e"].join("\n"));
  });

  it("stacks multiple inserts at the same position in source order", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when: two inserts at 1+ - first appears earlier in the patch
    const patch = `
@@@ 012 1+
first
@@@ 012

@@@ 012 1+
second
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then: source-order is preserved
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, ["a", "first", "second", "b"].join("\n"));
  });

  it("rejects patch with missing close marker", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when:
    const patch = `
@@@ 012 1-1
new
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Missing close marker/);
  });

  it("rejects patch with no blocks", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a"]);

    // when:
    const result = await patchFileTool.impl({
      filePath: tmpFilePath,
      patch: "",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /No patch blocks found/);
  });

  it("rejects replace range past end of file", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when:
    const patch = `
@@@ 012 1-5
X
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /extends past end of file/);
  });

  it("rejects insert with empty body", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when:
    const patch = `
@@@ 012 1+
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /empty body/);
  });

  it("treats $ characters in body as literal", async () => {
    // given:
    const tmpFilePath = await writeTmp(["Original text here"]);

    // when:
    const patch = `
@@@ 012 1-1
$& means match, $1 means first group, $$ means literal dollar
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      "$& means match, $1 means first group, $$ means literal dollar",
    );
  });

  it("rejects header with bad arguments", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a"]);

    // when:
    const patch = `
@@@ 012 abc
nope
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Invalid block header arguments/);
  });

  it("rejects close marker without an open block", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a"]);

    // when:
    const patch = `
@@@ 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Unexpected close marker/);
  });
});
