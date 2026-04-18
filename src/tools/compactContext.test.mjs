import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AGENT_MEMORY_DIR } from "../env.mjs";
import {
  compactContextToolName,
  createCompactContextTool,
  readMemoryForCompaction,
} from "./compactContext.mjs";

describe("compactContextTool", () => {
  it("exposes the expected tool definition", () => {
    const tool = createCompactContextTool();
    assert.equal(tool.def.name, compactContextToolName);
    assert.ok(typeof tool.def.description === "string");
    const schema = /** @type {Record<string, unknown>} */ (
      tool.def.inputSchema
    );
    assert.deepEqual(schema.required, ["memoryPath", "reason"]);
  });

  it("throws by default until an impl is injected", async () => {
    const tool = createCompactContextTool();
    await assert.rejects(
      tool.impl({ memoryPath: "x", reason: "y" }),
      /Not implemented/,
    );
  });

  it("supports injectImpl", async () => {
    const tool = createCompactContextTool();
    if (!tool.injectImpl) throw new Error("injectImpl is required");
    tool.injectImpl(async () => "ok");
    assert.equal(await tool.impl({ memoryPath: "x", reason: "y" }), "ok");
  });
});

describe("readMemoryForCompaction", () => {
  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];

  const generateRandomString = () => Math.random().toString(36).substring(2);

  afterEach(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  it("reads memory file and returns formatted result", async () => {
    // given:
    const fileName = `compactContextTest-${generateRandomString()}.md`;
    const memoryPath = path.join(AGENT_MEMORY_DIR, fileName);
    await fs.mkdir(AGENT_MEMORY_DIR, { recursive: true });
    await fs.writeFile(memoryPath, "# Task\n\nProgress", "utf8");
    cleanups.push(async () => await fs.rm(memoryPath));

    // when:
    const result = await readMemoryForCompaction({
      memoryPath,
      reason: "context is getting large",
    });

    // then:
    assert.equal(typeof result, "string");
    const text = /** @type {string} */ (result);
    assert.match(text, /Context compacted/);
    assert.match(text, /Reason: context is getting large/);
    assert.match(text, new RegExp(`Memory file: ${memoryPath}`));
    assert.match(text, /# Task\n\nProgress/);
  });

  it("rejects absolute paths outside of the memory directory", async () => {
    const result = await readMemoryForCompaction({
      memoryPath: "/etc/passwd",
      reason: "test",
    });
    assert.ok(result instanceof Error);
    assert.match(result.message, /Access denied/);
  });

  it("rejects relative paths that escape the memory directory", async () => {
    const result = await readMemoryForCompaction({
      memoryPath: `${AGENT_MEMORY_DIR}/../secret.md`,
      reason: "test",
    });
    assert.ok(result instanceof Error);
    assert.match(result.message, /Access denied/);
  });

  it("returns an error when the memory file does not exist", async () => {
    const result = await readMemoryForCompaction({
      memoryPath: path.join(
        AGENT_MEMORY_DIR,
        `nonexistent-${generateRandomString()}.md`,
      ),
      reason: "test",
    });
    assert.ok(result instanceof Error);
  });
});
