import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { createWriteFileTool, writeFileTool } from "./writeFile.mjs";

describe("writeFileTool", () => {
  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];

  const generateRandomString = () => Math.random().toString(36).substring(2);

  afterEach(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  it("rejects invalid inputs before asking the backend to write", async () => {
    // given:
    let writes = 0;
    const tool = createWriteFileTool({
      authorizeRead: async () => undefined,
      resolveToolTarget: async () => {
        throw new Error("unexpected resolution");
      },
      readStream: async () => {
        throw new Error("unexpected read");
      },
      readFile: async () => {
        throw new Error("unexpected read");
      },
      writeFile: async () => {
        writes++;
      },
    });
    const invalidInputs = [
      { filePath: "dest.txt" },
      { filePath: "dest.txt", content: null },
      { filePath: "dest.txt", content: 100 },
      { filePath: "", content: "hello" },
      { filePath: "invalid\0.txt", content: "hello" },
    ];

    // when/then:
    for (const input of invalidInputs) {
      assert.ok(tool.validateInput?.(input) instanceof Error);
      assert.ok((await tool.impl(input)) instanceof Error);
    }
    assert.equal(writes, 0);
    assert.equal(
      await tool.impl({ filePath: "dest.txt", content: "" }),
      "Wrote to file: dest.txt",
    );
    assert.equal(writes, 1);
  });

  it("writes to a file", async () => {
    // given:
    const tmpFilePath = `tmp/writeFileTest/writeFileTest-${generateRandomString()}.txt`;
    cleanups.push(
      async () => await fs.rm("tmp/writeFileTest", { recursive: true }),
    );

    // when:
    const result = await writeFileTool.impl({
      filePath: tmpFilePath,
      content: "Hello World",
    });

    // then:
    assert.equal(result, `Wrote to file: ${tmpFilePath}`);
    const writtenContent = await fs.readFile(tmpFilePath, "utf8");
    assert.equal(writtenContent, "Hello World");
  });
});
