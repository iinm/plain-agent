import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { createPatchFileTool } from "./patchFile.mjs";

describe("patchFileTool", () => {
  const patchFileTool = createPatchFileTool("012");

  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];

  const generateRandomString = () => Math.random().toString(36).substring(2);

  afterEach(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  it("patches a file", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = [
      "Hello World",
      "This is a test file content 1.",
      "This is a test file content 2.",
      "This is a test file content 3.",
    ].join("\n");
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const diff = `
<<< 012 <<< SEARCH
Hello World
=== 012 ===
Hello Universe
>>> 012 >>> REPLACE

<<< 012 <<< SEARCH
This is a test file content 2.
This is a test file content 3.
=== 012 ===
This is a test file content updated 2.
This is a test file content updated 3.
>>> 012 >>> REPLACE
`;
    const result = await patchFileTool.impl({ filePath: tmpFilePath, diff });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    const expectedContent = [
      "Hello Universe",
      "This is a test file content 1.",
      "This is a test file content updated 2.",
      "This is a test file content updated 3.",
    ].join("\n");
    assert.equal(patchedContent, expectedContent);
  });

  it("removes header content", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = [
      "Hello World",
      "This is a test file content 1.",
      "This is a test file content 2.",
      "This is a test file content 3.",
    ].join("\n");
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const diff = `
<<< 012 <<< SEARCH
Hello World
=== 012 ===
>>> 012 >>> REPLACE
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, diff });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    const expectedContent = [
      "This is a test file content 1.",
      "This is a test file content 2.",
      "This is a test file content 3.",
    ].join("\n");
    assert.equal(patchedContent, expectedContent);
  });

  it("removes footer content", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = [
      "Hello World",
      "This is a test file content 1.",
      "This is a test file content 2.",
      "This is a test file content 3.",
    ].join("\n");
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const diff = `
<<< 012 <<< SEARCH
This is a test file content 3.
=== 012 ===
>>> 012 >>> REPLACE
`.trim();
    const result = await patchFileTool.impl({ filePath: tmpFilePath, diff });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    const expectedContent = [
      "Hello World",
      "This is a test file content 1.",
      "This is a test file content 2.",
    ].join("\n");
    assert.equal(patchedContent, expectedContent);
  });

  it("replace content including markers", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = [
      "Hello World",
      "<<< SEARCH",
      "===",
      ">>> REPLACE",
    ].join("\n");
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when:
    const diff = `
<<< 012 <<< SEARCH
Hello World
<<< SEARCH
=== 012 ===
Hello Universe
marker 1
>>> 012 >>> REPLACE

<<< 012 <<< SEARCH
===
=== 012 ===
marker 2
>>> 012 >>> REPLACE

<<< 012 <<< SEARCH
>>> REPLACE
=== 012 ===
marker 3
>>> 012 >>> REPLACE
`;
    const result = await patchFileTool.impl({ filePath: tmpFilePath, diff });

    // then:
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    const expectedContent = [
      "Hello Universe",
      "marker 1",
      "marker 2",
      "marker 3",
    ].join("\n");
    assert.equal(patchedContent, expectedContent);
  });

  it("handles special characters in replacement string", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = "Hello World\nThis is a test.";
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when: replacement string contains special characters like $&, $1, $$, %
    const diff = `
<<< 012 <<< SEARCH
Hello World
=== 012 ===
Price: $100 & 50% off $& special $1 deal $$
>>> 012 >>> REPLACE
`;
    const result = await patchFileTool.impl({ filePath: tmpFilePath, diff });

    // then: special characters should be treated literally, not as regex replacement patterns
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    const expectedContent =
      "Price: $100 & 50% off $& special $1 deal $$\nThis is a test.";
    assert.equal(patchedContent, expectedContent);
  });

  it("handles dollar signs in replacement string", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = "Original text here";
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when: replacement string contains various dollar sign patterns
    const diff = `
<<< 012 <<< SEARCH
Original text here
=== 012 ===
$& means match, $1 means first group, $$ means literal dollar
>>> 012 >>> REPLACE
`;
    const result = await patchFileTool.impl({ filePath: tmpFilePath, diff });

    // then: all dollar signs should be treated literally
    assert.equal(result, `Patched file: ${tmpFilePath}`);
    const patchedContent = await fs.readFile(tmpFilePath, "utf8");
    const expectedContent =
      "$& means match, $1 means first group, $$ means literal dollar";
    assert.equal(patchedContent, expectedContent);
  });

  it("errors when nonce marker appears inside content", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = "dummy";
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when: search/replace content accidentally includes the separator marker
    const diff = `
<<< 012 <<< SEARCH
first section
=== 012 ===
second section
=== 012 ===
replaced!
>>> 012 >>> REPLACE
`;

    // then: validation catches duplicate separator (nSep > nSearch)
    const result = await patchFileTool.impl({ filePath: tmpFilePath, diff });
    assert.ok(result instanceof Error);
    assert.equal(
      result.message,
      'Each diff block needs exactly one "=== 012 ===" separator, but found 2 separators for 1 block(s). Did you accidentally include the separator marker in your search/replace content?',
    );
  });

  it("errors when block markers appear inside content", async () => {
    // given:
    const tmpFilePath = `tmp/patchFileTest-${generateRandomString()}.txt`;
    await fs.mkdir("tmp", { recursive: true });
    const initialContent = "dummy";
    await fs.writeFile(tmpFilePath, initialContent);
    cleanups.push(() => fs.unlink(tmpFilePath));

    // when: search content accidentally includes <<< 012 <<< SEARCH
    const diff = `
<<< 012 <<< SEARCH
some text
<<< 012 <<< SEARCH
oops
=== 012 ===
replacement
>>> 012 >>> REPLACE
`;

    // then: validation catches mismatched block markers (2 <<< but 1 >>>)
    const result = await patchFileTool.impl({ filePath: tmpFilePath, diff });
    assert.ok(result instanceof Error);
    assert.equal(
      result.message,
      'Mismatched block markers: found 2 "<<< 012 <<< SEARCH" but 1 ">>> 012 >>> REPLACE". Did you accidentally include a marker in your search/replace content?',
    );
  });
});
