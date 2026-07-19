import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { lineHash } from "../utils/lineHash.mjs";
import {
  collectPatchLineRanges,
  createPatchFileTool,
  getPatchPreviewSnapshotByInput,
  MAX_PATCH_PREVIEW_CACHE_ENTRIES,
  parseBlocks,
  patchPreviewCacheKey,
  renderPatchBlock,
} from "./patchFile.mjs";

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

  // --- 操作成功 (6 tests) ---

  it("replaces line ranges across multiple blocks", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      "Hello World",
      "This is a test file content 1.",
      "This is a test file content 2.",
      "This is a test file content 3.",
    ]);

    // when:
    const patch = [
      `REPLACE 012 1:${lineHash("Hello World")}-1:${lineHash("Hello World")}`,
      "Hello Universe",
      `REPLACE 012 3:${lineHash("This is a test file content 2.")}-4:${lineHash("This is a test file content 3.")}`,
      "This is a test file content updated 2.",
      "This is a test file content updated 3.",
    ].join("\n");
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

  it("deletes lines with empty body replace", async () => {
    // given:
    const tmpFilePath = await writeTmp([
      "Hello World",
      "drop me",
      "drop me too",
      "keep me",
    ]);

    // when: deletion = header immediately followed by next header (no body lines)
    const patch = [
      `REPLACE 012 2:${lineHash("drop me")}-3:${lineHash("drop me too")}`,
      `REPLACE 012 4:${lineHash("keep me")}-4:${lineHash("keep me")}`,
      "keep me",
    ].join("\n");
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, ["Hello World", "keep me"].join("\n"));
  });

  it("inserts content after a line with N:hash+", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo", "delta"]);

    // when: insert "charlie" after line 2
    const patch = [`INSERT_AFTER 012 2:${lineHash("bravo")}`, "charlie"].join(
      "\n",
    );
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ["alpha", "bravo", "charlie", "delta"].join("\n"),
    );
  });

  it("prepends and appends with 0+ and N:hash+ (including empty file)", async () => {
    // Sub-case 1: prepend/append on non-empty file
    // given:
    const tmpFilePath1 = await writeTmp(["middle"]);

    // when:
    const patch1 = [
      "INSERT_AFTER 012 0",
      "top",
      `INSERT_AFTER 012 1:${lineHash("middle")}`,
      "bottom",
    ].join("\n");
    const result1 = await patchFileTool.impl({
      filePath: tmpFilePath1,
      patch: patch1,
    });

    // then:
    assert.equal(result1, `Patched file: ${tmpFilePath1}`);
    const patchedContent1 = await fs.readFile(tmpFilePath1, "utf8");
    assert.equal(patchedContent1, ["top", "middle", "bottom"].join("\n"));

    // Sub-case 2: insert into empty file with 0+ — no spurious trailing newline
    // given: an empty file (read_file would report 0 lines).
    const tmpFilePath2 = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath2, "");
    cleanups.push(() => fs.unlink(tmpFilePath2));

    // when:
    const patch2 = ["INSERT_AFTER 012 0", "new content"].join("\n");
    const result2 = await patchFileTool.impl({
      filePath: tmpFilePath2,
      patch: patch2,
    });

    // then:
    assert.equal(result2, `Patched file: ${tmpFilePath2}`);
    const patchedContent2 = await fs.readFile(tmpFilePath2, "utf8");
    assert.equal(patchedContent2, "new content");
  });

  it("replaces a single line using N:hash shorthand", async () => {
    // given:
    const tmpFilePath = await writeTmp(["one", "two", "three"]);

    // when: shorthand "2:hash" means replace just line 2
    const patch = [`REPLACE 012 2:${lineHash("two")}`, "TWO"].join("\n");
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(patchedContent, ["one", "TWO", "three"].join("\n"));
  });

  it("uses original line numbers across blocks that change line count", async () => {
    // given:
    const tmpFilePath = await writeTmp(["one", "two", "three", "four", "five"]);

    // when: line numbers refer to ORIGINAL file even though block 1 changes line count
    const patch = [
      `REPLACE 012 1:${lineHash("one")}-1:${lineHash("one")}`,
      "ONE",
      "TWO",
      `REPLACE 012 5:${lineHash("five")}-5:${lineHash("five")}`,
      "FIVE",
    ].join("\n");
    await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ["ONE", "TWO", "two", "three", "four", "FIVE"].join("\n"),
    );
  });

  // --- ファイル状態 (1 test) ---

  it("preserves or omits trailing newline matching original", async () => {
    // Sub-case 1: original has trailing newline → preserved
    // given:
    const tmpFilePath1 = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.writeFile(tmpFilePath1, "alpha\nbravo\n");
    cleanups.push(() => fs.unlink(tmpFilePath1));

    // when:
    const patch1 = [
      `REPLACE 012 1:${lineHash("alpha")}-1:${lineHash("alpha")}`,
      "ALPHA",
    ].join("\n");
    await patchFileTool.impl({ filePath: tmpFilePath1, patch: patch1 });

    // then:
    const patchedContent1 = await fs.readFile(tmpFilePath1, "utf8");
    assert.equal(patchedContent1, "ALPHA\nbravo\n");

    // Sub-case 2: original lacks trailing newline → not introduced
    // given:
    const tmpFilePath2 = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.writeFile(tmpFilePath2, "alpha\nbravo");
    cleanups.push(() => fs.unlink(tmpFilePath2));

    // when:
    const patch2 = [
      `REPLACE 012 2:${lineHash("bravo")}-2:${lineHash("bravo")}`,
      "BRAVO",
    ].join("\n");
    await patchFileTool.impl({ filePath: tmpFilePath2, patch: patch2 });

    // then:
    const patchedContent2 = await fs.readFile(tmpFilePath2, "utf8");
    assert.equal(patchedContent2, "alpha\nBRAVO");
  });

  // --- ハッシュ検証成功 (1 test) ---

  it("hash verification passes for various content types", async () => {
    // Sub-case 1: indented code line
    // given:
    const tmpFilePath1 = await writeTmp([
      "  export function foo() {",
      "    return 1;",
      "  }",
    ]);

    // when:
    const patch1 = [
      `REPLACE 012 2:${lineHash("    return 1;")}-2:${lineHash("    return 1;")}`,
      "    return 42;",
    ].join("\n");
    const result1 = await patchFileTool.impl({
      filePath: tmpFilePath1,
      patch: patch1,
    });

    // then:
    assert.equal(result1, `Patched file: ${tmpFilePath1}`);
    const patchedContent1 = await fs.readFile(tmpFilePath1, "utf8");
    assert.equal(
      patchedContent1,
      ["  export function foo() {", "    return 42;", "  }"].join("\n"),
    );

    // Sub-case 2: blank/whitespace-only lines
    for (const middle of ["", "   "]) {
      const tmpFilePath = await writeTmp(["alpha", middle, "charlie"]);

      const patch = [
        `REPLACE 012 2:${lineHash(middle)}-2:${lineHash(middle)}`,
        "bravo",
      ].join("\n");
      const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

      assert.equal(result, `Patched file: ${tmpFilePath}`);
      const patchedContent = await fs.readFile(tmpFilePath, "utf8");
      assert.equal(patchedContent, ["alpha", "bravo", "charlie"].join("\n"));
    }
  });

  // --- ハッシュ検証失敗 (2 tests) ---

  it("rejects replace when hash does not match (start or end)", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo", "charlie"]);

    // Sub-case 1: start hash mismatch
    const patch1 = [
      `REPLACE 012 2:${lineHash("alpha")}-2:${lineHash("alpha")}`,
      "new",
    ].join("\n");
    const result1 = await patchFileTool.impl({
      filePath: tmpFilePath,
      patch: patch1,
    });
    assert.ok(result1 instanceof Error);
    assert.match(result1.message, /Hash verification failed at line 2/);

    // Sub-case 2: end hash mismatch (start hash correct)
    const patch2 = [
      `REPLACE 012 2:${lineHash("bravo")}-3:${lineHash("alpha")}`,
      "new",
    ].join("\n");
    const result2 = await patchFileTool.impl({
      filePath: tmpFilePath,
      patch: patch2,
    });
    assert.ok(result2 instanceof Error);
    assert.match(result2.message, /Hash verification failed at line 3/);
  });

  it("rejects insert when afterHash does not match", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo"]);

    // when: insert after line 1 but hash is wrong
    const patch = [`INSERT_AFTER 012 1:${lineHash("bravo")}`, "inserted"].join(
      "\n",
    );
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Hash verification failed at line 1/);
  });

  // --- 競合検出 (2 tests) ---

  it("rejects overlapping replace ranges", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b", "c", "d", "e"]);

    // when:
    const patch = [
      `REPLACE 012 1:${lineHash("a")}-3:${lineHash("c")}`,
      "X",
      `REPLACE 012 3:${lineHash("c")}-5:${lineHash("e")}`,
      "Y",
    ].join("\n");
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /overlap/);
  });

  it("rejects insert inside replace range but allows at boundary", async () => {
    // given:
    const tmpFilePath1 = await writeTmp(["a", "b", "c", "d", "e"]);
    const tmpFilePath2 = await writeTmp(["a", "b", "c"]);
    const tmpFilePath3 = await writeTmp(["a", "b", "c"]);

    // Sub-case 1: insert inside replace range → rejected
    const patch1 = [
      `REPLACE 012 1:${lineHash("a")}-3:${lineHash("c")}`,
      "X",
      `INSERT_AFTER 012 2:${lineHash("b")}`,
      "Y",
    ].join("\n");
    const result1 = await patchFileTool.impl({
      filePath: tmpFilePath1,
      patch: patch1,
    });
    assert.ok(result1 instanceof Error);
    assert.match(result1.message, /falls inside replace/);

    // Sub-case 2: insert at boundary (after end) → allowed
    const patch2 = [
      `REPLACE 012 1:${lineHash("a")}-3:${lineHash("c")}`,
      "X",
      `INSERT_AFTER 012 3:${lineHash("c")}`,
      "Y",
    ].join("\n");
    const result2 = await patchFileTool.impl({
      filePath: tmpFilePath2,
      patch: patch2,
    });
    assert.equal(result2, `Patched file: ${tmpFilePath2}`);
    const patchedContent2 = await fs.readFile(tmpFilePath2, "utf8");
    assert.equal(patchedContent2, ["X", "Y"].join("\n"));

    // Sub-case 3: insert at boundary (before start) → allowed
    const patch3 = [
      "INSERT_AFTER 012 0",
      "Y",
      `REPLACE 012 1:${lineHash("a")}-3:${lineHash("c")}`,
      "X",
    ].join("\n");
    const result3 = await patchFileTool.impl({
      filePath: tmpFilePath3,
      patch: patch3,
    });
    assert.equal(result3, `Patched file: ${tmpFilePath3}`);
    const patchedContent3 = await fs.readFile(tmpFilePath3, "utf8");
    assert.equal(patchedContent3, ["Y", "X"].join("\n"));
  });

  // --- 検証エラー (4 tests) ---

  it("rejects replace range extending past end of file (including empty file)", async () => {
    // Sub-case 1: non-empty file, range extends past EOF
    // given:
    const tmpFilePath1 = await writeTmp(["a", "b"]);

    // when:
    const patch1 = [`REPLACE 012 1:${lineHash("a")}-3:ab`, "X"].join("\n");
    const result1 = await patchFileTool.impl({
      filePath: tmpFilePath1,
      patch: patch1,
    });

    // then:
    assert.ok(result1 instanceof Error);
    assert.match(result1.message, /extends past end of file \(2 lines\)/);

    // Sub-case 2: empty file, replace 1-1 (no line 1 exists)
    const tmpFilePath2 = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    await fs.writeFile(tmpFilePath2, "");
    cleanups.push(() => fs.unlink(tmpFilePath2));

    const patch2 = ["REPLACE 012 1:61-1:61", "new"].join("\n");
    const result2 = await patchFileTool.impl({
      filePath: tmpFilePath2,
      patch: patch2,
    });

    assert.ok(result2 instanceof Error);
    assert.match(result2.message, /extends past end of file \(0 lines\)/);
  });

  it("rejects insert position outside [0, totalLines]", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when: insert at 3+ but file only has 2 lines
    const patch = ["INSERT_AFTER 012 3:ab", "X"].join("\n");
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /outside \[0, 2\]/);
  });

  it("rejects invalid replace range (start < 1 or end < start)", async () => {
    // Sub-case 1: start < 1
    // given:
    const tmpFilePath1 = await writeTmp(["a"]);

    // when:
    const patch1 = [`REPLACE 012 0:ab-1:${lineHash("a")}`, "X"].join("\n");
    const result1 = await patchFileTool.impl({
      filePath: tmpFilePath1,
      patch: patch1,
    });

    // then:
    assert.ok(result1 instanceof Error);
    assert.match(result1.message, /start must be >= 1/);

    // Sub-case 2: end < start
    // given:
    const tmpFilePath2 = await writeTmp(["a", "b", "c", "d", "e"]);

    // when:
    const patch2 = [
      `REPLACE 012 5:${lineHash("e")}-3:${lineHash("c")}`,
      "X",
    ].join("\n");
    const result2 = await patchFileTool.impl({
      filePath: tmpFilePath2,
      patch: patch2,
    });

    // then:
    assert.ok(result2 instanceof Error);
    assert.match(result2.message, /end \(3\) must be >= start \(5\)/);
  });

  it("rejects insert with empty body", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // when: insert with no body — next header follows immediately
    const patch = [
      `INSERT_AFTER 012 1:${lineHash("a")}`,
      `INSERT_AFTER 012 2:${lineHash("b")}`,
      "X",
    ].join("\n");
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /empty body/);
  });

  // --- パースエラー (1 test) ---

  it("rejects various invalid header formats", async () => {
    // given:
    const tmpFilePath = await writeTmp(["a", "b"]);

    // Sub-case 1: bad arguments (no matching pattern)
    const patch1 = ["REPLACE 012 abc", "nope"].join("\n");
    const result1 = await patchFileTool.impl({
      filePath: tmpFilePath,
      patch: patch1,
    });
    assert.ok(result1 instanceof Error);
    assert.match(result1.message, /Invalid replace header arguments/);

    // Sub-case 2: incomplete range
    const patch2 = [`REPLACE 012 2:${lineHash("b")}-`, "X"].join("\n");
    const result2 = await patchFileTool.impl({
      filePath: tmpFilePath,
      patch: patch2,
    });
    assert.ok(result2 instanceof Error);
    assert.match(result2.message, /Invalid replace header arguments/);

    // Sub-case 3: end hash mismatch (valid range but wrong hash)
    const patch3 = [`REPLACE 012 1:${lineHash("a")}-2:ab`, "X"].join("\n");
    const result3 = await patchFileTool.impl({
      filePath: tmpFilePath,
      patch: patch3,
    });
    assert.ok(result3 instanceof Error);
    assert.match(result3.message, /Hash verification failed at line 2/);
  });

  // --- 特殊動作 (2 tests) ---

  it("treats body content as literal (preserves $, empty lines)", async () => {
    // Sub-case 1: $ characters treated as literal (no regex substitution)
    // given:
    const tmpFilePath1 = await writeTmp(["Original text here"]);

    // when:
    const patch1 = [
      `REPLACE 012 1:${lineHash("Original text here")}-1:${lineHash("Original text here")}`,
      "$& means match, $1 means first group, $$ means literal dollar",
    ].join("\n");
    const result1 = await patchFileTool.impl({
      filePath: tmpFilePath1,
      patch: patch1,
    });

    // then:
    assert.equal(result1, `Patched file: ${tmpFilePath1}`);
    const patchedContent1 = await fs.readFile(tmpFilePath1, "utf8");
    assert.equal(
      patchedContent1,
      "$& means match, $1 means first group, $$ means literal dollar",
    );

    // Sub-case 2: empty lines within body preserved
    // given:
    const tmpFilePath2 = await writeTmp(["a", "b"]);

    // when: body contains empty lines
    const patch2 = [
      `REPLACE 012 1:${lineHash("a")}-1:${lineHash("a")}`,
      "X",
      "",
      "Z",
      `REPLACE 012 2:${lineHash("b")}-2:${lineHash("b")}`,
      "Y",
    ].join("\n");
    const result2 = await patchFileTool.impl({
      filePath: tmpFilePath2,
      patch: patch2,
    });

    // then:
    assert.equal(result2, `Patched file: ${tmpFilePath2}`);
    const patchedContent2 = await fs.readFile(tmpFilePath2, "utf8");
    assert.equal(patchedContent2, ["X", "", "Z", "Y"].join("\n"));
  });

  it("orders multiple inserts at the same position by source order", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "delta"]);

    // when: two inserts at the same position — first-in-source ends up topmost
    const patch = [
      `INSERT_AFTER 012 1:${lineHash("alpha")}`,
      "bravo",
      `INSERT_AFTER 012 1:${lineHash("alpha")}`,
      "charlie",
    ].join("\n");
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ["alpha", "bravo", "charlie", "delta"].join("\n"),
    );
  });
});

describe("parseBlocks", () => {
  it("parses replace block with hash", () => {
    // given:
    const patch = ["REPLACE xyz 1:7b-3:20", "new content"].join("\n");

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
    const patch = ["INSERT_AFTER xyz 2:20", "inserted"].join("\n");

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
    const patch = ["INSERT_AFTER xyz 0", "prepended"].join("\n");

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

  it("parses single line replace shorthand", () => {
    // given:
    const patch = ["REPLACE xyz 5:ab", "new"].join("\n");

    // when:
    const blocks = parseBlocks(patch, "xyz");

    // then:
    assert.equal(blocks.length, 1);
    const block =
      /** @type {import("./patchFile").PatchBlock & {op: "replace"}} */ (
        blocks[0]
      );
    assert.equal(block.op, "replace");
    assert.equal(block.start, 5);
    assert.equal(block.end, 5);
    assert.equal(block.startHash, "ab");
    assert.equal(block.endHash, "ab");
    assert.deepEqual(block.body, ["new"]);
  });

  it("parses multiple blocks with no separator lines", () => {
    // given:
    const patch = [
      "REPLACE xyz 1:7b-1:7b",
      "first",
      "REPLACE xyz 3:20-3:20",
      "second",
    ].join("\n");

    // when:
    const blocks = parseBlocks(patch, "xyz");

    // then:
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0].body, ["first"]);
    assert.deepEqual(blocks[1].body, ["second"]);
  });

  it("parses deletion block (empty body at end of patch)", () => {
    // given:
    const patch = "REPLACE xyz 5:ab-5:ab";

    // when:
    const blocks = parseBlocks(patch, "xyz");

    // then:
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].op, "replace");
    assert.deepEqual(blocks[0].body, []);
  });

  it("parses deletion block (empty body followed by next header)", () => {
    // given:
    const patch = [
      "REPLACE xyz 5:ab-5:ab",
      "INSERT_AFTER xyz 3:cd",
      "new",
    ].join("\n");

    // when:
    const blocks = parseBlocks(patch, "xyz");

    // then:
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0].body, []);
    assert.deepEqual(blocks[1].body, ["new"]);
  });
  it("throws for patch with wrong nonce", () => {
    // given:
    const patch = ["REPLACE abc 1:7b-3:20", "content"].join("\n");

    // when/then:
    assert.throws(() => parseBlocks(patch, "xyz"), /No patch blocks found/);
  });

  it("throws for patch with no headers at all", () => {
    // given:
    const patch = "just some plain text";

    // when/then:
    assert.throws(() => parseBlocks(patch, "xyz"), /No patch blocks found/);
  });
});

describe("collectPatchLineRanges", () => {
  it("collects the union of replace ranges, ignoring inserts", () => {
    // given:
    /** @type {import("./patchFile").PatchBlock[]} */
    const blocks = [
      {
        op: "replace",
        start: 5,
        end: 6,
        startHash: "aa",
        endHash: "bb",
        body: [],
      },
      { op: "insert", after: 10, afterHash: "cc", body: ["x"] },
      {
        op: "replace",
        start: 1,
        end: 2,
        startHash: "dd",
        endHash: "ee",
        body: [],
      },
    ];

    // when:
    const ranges = collectPatchLineRanges(blocks);

    // then: sorted ascending, insert excluded.
    assert.deepEqual(ranges, [
      [1, 2],
      [5, 6],
    ]);
  });

  it("merges overlapping and adjacent ranges", () => {
    // given:
    /** @type {import("./patchFile").PatchBlock[]} */
    const blocks = [
      {
        op: "replace",
        start: 1,
        end: 3,
        startHash: "aa",
        endHash: "bb",
        body: [],
      },
      {
        op: "replace",
        start: 3,
        end: 5,
        startHash: "cc",
        endHash: "dd",
        body: [],
      },
      {
        op: "replace",
        start: 6,
        end: 7,
        startHash: "ee",
        endHash: "ff",
        body: [],
      },
    ];

    // when:
    const ranges = collectPatchLineRanges(blocks);

    // then: 1-3 overlaps 3-5, and 6-7 is adjacent to 5 → all merged.
    assert.deepEqual(ranges, [[1, 7]]);
  });

  it("returns an empty list when there are no replace blocks", () => {
    // given:
    /** @type {import("./patchFile").PatchBlock[]} */
    const blocks = [{ op: "insert", after: 0, afterHash: "", body: ["x"] }];

    // when/then:
    assert.deepEqual(collectPatchLineRanges(blocks), []);
  });
});

describe("patchPreviewCacheKey", () => {
  it("is deterministic for the same filePath and patch", () => {
    // given:
    const input = { filePath: "a/b.txt", patch: "REPLACE 012 1:aa\nnew" };

    // when:
    const key1 = patchPreviewCacheKey(input);
    const key2 = patchPreviewCacheKey({ ...input });

    // then:
    assert.equal(key1, key2);
    assert.match(key1, /^[a-f0-9]{64}$/);
  });

  it("differs when filePath or patch differ", () => {
    // given/when:
    const base = patchPreviewCacheKey({ filePath: "a.txt", patch: "p" });
    const otherPath = patchPreviewCacheKey({ filePath: "b.txt", patch: "p" });
    const otherPatch = patchPreviewCacheKey({ filePath: "a.txt", patch: "q" });

    // then:
    assert.notEqual(base, otherPath);
    assert.notEqual(base, otherPatch);
  });
});

describe("renderPatchBlock with a sparse snapshot", () => {
  it("renders a replace diff from a sparse snapshot", () => {
    // given: only the touched lines are present in the snapshot.
    /** @type {import("./patchFile").PatchBlock} */
    const block = {
      op: "replace",
      start: 2,
      end: 3,
      startHash: "aa",
      endHash: "bb",
      body: ["NEW"],
    };
    /** @type {import("./patchFile").PatchPreviewSnapshot} */
    const snapshot = { totalLines: 5, lines: { 2: "two", 3: "three" } };

    // when:
    const out = renderPatchBlock(block, snapshot, "xyz");

    // then:
    assert.equal(
      out,
      ["REPLACE xyz 2:aa-3:bb", "- two", "- three", "+ NEW"].join("\n"),
    );
  });

  it("caps the end bound using the snapshot's totalLines", () => {
    // given: block.end (6) exceeds totalLines (5).
    /** @type {import("./patchFile").PatchBlock} */
    const block = {
      op: "replace",
      start: 5,
      end: 6,
      startHash: "aa",
      endHash: "bb",
      body: ["NEW"],
    };
    /** @type {import("./patchFile").PatchPreviewSnapshot} */
    const snapshot = { totalLines: 5, lines: { 5: "five" } };

    // when:
    const out = renderPatchBlock(block, snapshot, "xyz");

    // then: only line 5 is treated as removed.
    assert.equal(out, ["REPLACE xyz 5:aa-6:bb", "- five", "+ NEW"].join("\n"));
  });

  it("still renders from an absolute line array (backward compatible)", () => {
    // given:
    /** @type {import("./patchFile").PatchBlock} */
    const block = {
      op: "replace",
      start: 1,
      end: 1,
      startHash: "aa",
      endHash: "aa",
      body: ["NEW"],
    };

    // when:
    const out = renderPatchBlock(block, ["old", "keep"], "xyz");

    // then:
    assert.equal(out, ["REPLACE xyz 1:aa-1:aa", "- old", "+ NEW"].join("\n"));
  });
});

describe("patch preview cache (LRU)", () => {
  const patchFileTool = createPatchFileTool("012");

  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];

  const generateRandomString = () => Math.random().toString(36).substring(2);

  /**
   * @param {string[]} lines
   * @returns {Promise<string>}
   */
  const writeTmp = async (lines) => {
    const tmpFilePath = `tmp/patchCacheTest-${generateRandomString()}.txt`;
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

  it("stores a sparse before-snapshot on execution, keyed by input", async () => {
    // given:
    const tmpFilePath = await writeTmp(["alpha", "bravo", "charlie"]);
    const patch = [
      `REPLACE 012 2:${lineHash("bravo")}-2:${lineHash("bravo")}`,
      "BRAVO!",
    ].join("\n");
    const input = { filePath: tmpFilePath, patch };

    // when:
    await patchFileTool.impl(input);

    // then: the snapshot holds the pre-write line 2 only, plus total count.
    const snapshot = getPatchPreviewSnapshotByInput(input);
    assert.ok(snapshot);
    assert.equal(snapshot.totalLines, 3);
    assert.deepEqual(snapshot.lines, { 2: "bravo" });
  });

  it("evicts the oldest entry once the size limit is exceeded", async () => {
    // given: run more patches than the cache can hold, tracking every input.
    /** @type {{ filePath: string; patch: string }[]} */
    const inputs = [];
    const total = MAX_PATCH_PREVIEW_CACHE_ENTRIES + 3;

    // when:
    for (let i = 0; i < total; i++) {
      const tmpFilePath = await writeTmp(["x"]);
      const patch = [
        `REPLACE 012 1:${lineHash("x")}-1:${lineHash("x")}`,
        `y${i}`,
      ].join("\n");
      const input = { filePath: tmpFilePath, patch };
      inputs.push(input);
      await patchFileTool.impl(input);
    }

    // then: the oldest entry is gone, the newest remains.
    assert.equal(getPatchPreviewSnapshotByInput(inputs[0]), null);
    assert.ok(getPatchPreviewSnapshotByInput(inputs[inputs.length - 1]));
  });
});
