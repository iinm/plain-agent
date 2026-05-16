import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { lineHash } from "../utils/lineHash.mjs";
import { createPatchFileTool, parseBlocks } from "./patchFile.mjs";

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
>>> 012 1:${lineHash("Hello World")}-1:${lineHash("Hello World")}
Hello Universe
<<< 012

>>> 012 3:${lineHash("This is a test file content 2.")}-4:${lineHash("This is a test file content 3.")}
This is a test file content updated 2.
This is a test file content updated 3.
<<< 012
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
>>> 012 2:${lineHash("drop me")}-3:${lineHash("drop me too")}
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, ["Hello World", "keep me"].join("\n"));
  });

  it("inserts content with N:hash+ syntax (after a line)", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo", "delta"]);

    // when: insert "charlie" after line 2
    const patch = `
>>> 012 2:${lineHash("bravo")}+
charlie
<<< 012
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

  it("prepends with 0+ and appends with {lastLine}:{hash}+", async () => {
    // given:
    const tmpFilePath = await writeTmp(["middle"]);

    // when:
    const patch = `
>>> 012 0+
top
<<< 012

>>> 012 1:${lineHash("middle")}+
bottom
<<< 012
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
>>> 012 0+
new content
<<< 012
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
>>> 012 1:61-1:61
new
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /extends past end of file \(0 lines\)/);
  });

  it("preserves trailing newline when present", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.writeFile(tmpFilePath, "alpha\nbravo\n");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const patch = `
>>> 012 1:${lineHash("alpha")}-1:${lineHash("alpha")}
ALPHA
<<< 012
`.trim();
    await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, "ALPHA\nbravo\n");
  });

  it("does not introduce trailing newline when original lacked one", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.writeFile(tmpFilePath, "alpha\nbravo");
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const patch = `
>>> 012 2:${lineHash("bravo")}-2:${lineHash("bravo")}
BRAVO
<<< 012
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
>>> 012 1:${lineHash("one")}-1:${lineHash("one")}
ONE
TWO
<<< 012

>>> 012 5:${lineHash("five")}-5:${lineHash("five")}
FIVE
<<< 012
`.trim();
    await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ["ONE", "TWO", "two", "three", "four", "FIVE"].join("\n"),
    );
  });

  it("hash verification passes when first line matches exactly", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      "  export function foo() {",
      "    return 1;",
      "  }",
    ]);

    // when:
    const patch = `
>>> 012 2:${lineHash("    return 1;")}-2:${lineHash("    return 1;")}
    return 42;
<<< 012
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

  it("hash verification passes for lines with quotes and special characters", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      'const greeting = "hello world";',
      "console.log(greeting);",
    ]);

    // when:
    const patch = `
>>> 012 1:${lineHash('const greeting = "hello world";')}-1:${lineHash('const greeting = "hello world";')}
const greeting = "Hello, World!";
<<< 012
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

  it("hash verification fails when start hash does not match", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo", "charlie"]);

    // when: hash claims "alpha" but actual line 2 is "bravo"
    const patch = `
>>> 012 2:${lineHash("alpha")}-2:${lineHash("alpha")}
new
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Hash verification failed at line 2/);
    assert.match(result.message, /re-read the file with read_file/);
  });

  it("hash verification fails when end hash does not match", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo", "charlie"]);

    // when: start hash is correct but end hash is wrong
    const patch = `
>>> 012 2:${lineHash("bravo")}-3:${lineHash("alpha")}
new
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Hash verification failed at line 3/);
  });

  it("hash verification fails for insert when afterHash does not match", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo"]);

    // when: insert after line 1 but hash is wrong
    const patch = `
>>> 012 1:${lineHash("bravo")}+
inserted
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Hash verification failed at line 1/);
  });

  it("accepts empty line hash for blank/whitespace-only lines", async () => {
    // given: two files differing only in whether line 2 is "" or "   ".
    for (const middle of ["", "   "]) {
      const tmpFilePath = await writeTmp(["alpha", middle, "charlie"]);

      // when:
      const patch = `
>>> 012 2:${lineHash(middle)}-2:${lineHash(middle)}
bravo
<<< 012
`.trim();
      const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

      // then:
      assert.equal(result, `Patched file: ${tmpFilePath}`);
      const patchedContent = await fs.readFile(tmpFilePath, "utf8");
      assert.equal(patchedContent, ["alpha", "bravo", "charlie"].join("\n"));
    }
  });

  it("rejects hash mismatch when target line is not blank", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo", "charlie"]);

    // when: line 2 is "bravo", not blank, so empty hash should fail.
    const patch = `
>>> 012 2:00-2:00
new
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Hash verification failed/);
  });

  it("rejects overlapping replace ranges", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b", "c", "d", "e"]);

    // when:
    const patch = `
>>> 012 1:${lineHash("a")}-3:${lineHash("c")}
X
<<< 012

>>> 012 3:${lineHash("c")}-5:${lineHash("e")}
Y
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /overlap/);
  });

  it("rejects insert inside replace range", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b", "c", "d", "e"]);

    // when: insert at 2+ falls inside replace 1-3
    const patch = `
>>> 012 1:${lineHash("a")}-3:${lineHash("c")}
X
<<< 012

>>> 012 2:${lineHash("b")}+
Y
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /falls inside replace/);
  });

  it("allows insert at replace boundary (after end)", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b", "c"]);

    // when: insert at 3+ (after the end of replace 1-3)
    const patch = `
>>> 012 1:${lineHash("a")}-3:${lineHash("c")}
X
<<< 012

>>> 012 3:${lineHash("c")}+
Y
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, ["X", "Y"].join("\n"));
  });

  it("allows insert at replace boundary (before start)", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b", "c"]);

    // when: insert at 0+ (before start of replace 1-3)
    const patch = `
>>> 012 1:${lineHash("a")}-3:${lineHash("c")}
X
<<< 012

>>> 012 0+
Y
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, ["Y", "X"].join("\n"));
  });

  it("rejects replace range extending past end of file", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when:
    const patch = `
>>> 012 1:${lineHash("a")}-3:ab
X
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /extends past end of file \(2 lines\)/);
  });

  it("rejects insert position outside [0, totalLines]", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when: insert at 3+ but file only has 2 lines
    const patch = `
>>> 012 3:ab+
X
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /outside \[0, 2\]/);
  });

  it("rejects start < 1 in replace range", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a"]);

    // when:
    const patch = `
>>> 012 0:ab-1:${lineHash("a")}
X
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /start must be >= 1/);
  });

  it("rejects end < start in replace range", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b", "c", "d", "e"]);

    // when:
    const patch = `
>>> 012 5:${lineHash("e")}-3:${lineHash("c")}
X
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /end \(3\) must be >= start \(5\)/);
  });

  it("rejects insert with empty body", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when:
    const patch = `
>>> 012 1:${lineHash("a")}+
<<< 012
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
>>> 012 1:${lineHash("Original text here")}-1:${lineHash("Original text here")}
$& means match, $1 means first group, $$ means literal dollar
<<< 012
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
>>> 012 abc
nope
<<< 012
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
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Unexpected close marker/);
  });

  it("rejects HEAD= format (backward incompatible)", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when: old HEAD= format should be rejected
    const patch = `
>>> 012 1-1 HEAD=a
X
<<< 012
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Invalid block header arguments/);
  });
});

describe("parseBlocks", () => {
  it("parses replace block with hash", () => {
    // given:
    const patch = `
>>> xyz 1:7b-3:20
new content
<<< xyz
`.trim();

    // when:
    const blocks = parseBlocks(patch, "xyz");

    // then:
    assert.equal(blocks.length, 1);
    const block =
      /** @type {import("./patchFile").PatchBlock & {op: "replace"}} */ (
        blocks[0]
      );
    assert.equal(block.op, "replace");
    assert.equal(block.start, 1);
    assert.equal(block.end, 3);
    assert.equal(block.startHash, "7b");
    assert.equal(block.endHash, "20");
    assert.deepEqual(block.body, ["new content"]);
  });

  it("parses insert block with hash", () => {
    // given:
    const patch = `
>>> xyz 2:20+
inserted
<<< xyz
`.trim();

    // when:
    const blocks = parseBlocks(patch, "xyz");

    // then:
    assert.equal(blocks.length, 1);
    const block =
      /** @type {import("./patchFile").PatchBlock & {op: "insert"}} */ (
        blocks[0]
      );
    assert.equal(block.op, "insert");
    assert.equal(block.after, 2);
    assert.equal(block.afterHash, "20");
    assert.deepEqual(block.body, ["inserted"]);
  });

  it("parses insert block with 0+ (no hash)", () => {
    // given:
    const patch = `
>>> xyz 0+
prepended
<<< xyz
`.trim();

    // when:
    const blocks = parseBlocks(patch, "xyz");

    // then:
    assert.equal(blocks.length, 1);
    const block =
      /** @type {import("./patchFile").PatchBlock & {op: "insert"}} */ (
        blocks[0]
      );
    assert.equal(block.op, "insert");
    assert.equal(block.after, 0);
    assert.equal(block.afterHash, "");
    assert.deepEqual(block.body, ["prepended"]);
  });

  it("rejects a second open marker before the first block is closed (missing close marker)", () => {
    // given: 1つ目のブロックの終了マーカーがなく、2つ目のブロックが開始されている
    const patch = `
>>> xyz 1:7b-1:7b
new content
>>> xyz 3:20-3:20
other content
<<< xyz
`.trim();

    // when/then:
    assert.throws(
      () => parseBlocks(patch, "xyz"),
      /Unclosed block|close marker/i,
    );
  });
});
