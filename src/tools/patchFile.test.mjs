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

  /**
   * The result now starts with the "Patched file: <path>" line followed by a
   * diff, so assert on the prefix rather than exact equality. Returns the
   * narrowed string result so callers can make further assertions on the diff.
   * @param {unknown} result
   * @param {string} filePath
   * @returns {string}
   */
  const assertPatched = (result, filePath) => {
    assert.ok(
      typeof result === "string",
      `expected string result, got: ${result}`,
    );
    assert.ok(
      result.startsWith(`Patched file: ${filePath}`),
      `unexpected result: ${result}`,
    );
    return result;
  };

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
    assertPatched(result, tmpFilePath);
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
    assertPatched(result, tmpFilePath);
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
    assertPatched(result, tmpFilePath);
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
    assertPatched(result1, tmpFilePath1);
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
    assertPatched(result2, tmpFilePath2);
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
    assertPatched(result, tmpFilePath);
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
    assertPatched(result1, tmpFilePath1);
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

      assertPatched(result, tmpFilePath);
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
    assertPatched(result2, tmpFilePath2);
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
    assertPatched(result3, tmpFilePath3);
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
    assertPatched(result1, tmpFilePath1);
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
    assertPatched(result2, tmpFilePath2);
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
    assertPatched(result, tmpFilePath);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(
      patchedContent,
      ["alpha", "bravo", "charlie", "delta"].join("\n"),
    );
  });

  // --- 差分出力 (3 tests) ---

  it("includes a line-numbered diff of the applied changes", async () => {
    // given:
    const tmpFilePath = await writeTmp(["one", "two", "three"]);

    // when:
    const patch = [`REPLACE 012 2:${lineHash("two")}`, "TWO"].join("\n");
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    const diff = assertPatched(result, tmpFilePath);
    // removed line uses its original number, added line its new number,
    // and surrounding unchanged lines appear as context.
    assert.match(diff, /^- 2 \| two$/m);
    assert.match(diff, /^\+ 2 \| TWO$/m);
    assert.match(diff, /^ {2}1 \| one$/m);
    assert.match(diff, /^ {2}3 \| three$/m);
  });

  it("reports no changes when the patch does not alter content", async () => {
    // given:
    const tmpFilePath = await writeTmp(["one", "two", "three"]);

    // when: replace a line with an identical value
    const patch = [`REPLACE 012 2:${lineHash("two")}`, "two"].join("\n");
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    const diff = assertPatched(result, tmpFilePath);
    assert.match(diff, /\(no changes\)/);
  });

  it("renders the full diff without omitting distant context", async () => {
    // given: a change near the top of a longer file.
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const tmpFilePath = await writeTmp(lines);

    // when:
    const patch = [`REPLACE 012 1:${lineHash("line 1")}`, "LINE 1"].join("\n");
    const result = await patchFileTool.impl({ filePath: tmpFilePath, patch });

    // then:
    const diff = assertPatched(result, tmpFilePath);
    assert.match(diff, /^- 1 \| line 1$/m);
    assert.match(diff, /^\+ 1 \| LINE 1$/m);
    // every unchanged line is shown in full — no "..." omission marker.
    assert.match(diff, /^ {2}30 \| line 30$/m);
    assert.ok(!diff.includes("..."), `unexpected result: ${diff}`);
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
