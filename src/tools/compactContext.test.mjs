import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AGENT_MEMORY_DIR } from "../env.mjs";
import { createFileAccess } from "../fileAccess.mjs";
import { createSubagentManager } from "../subagent.mjs";
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

  it("uses the sandbox memory directory for compaction and subagent reports", async () => {
    // given:
    const sandboxDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plain-agent-memory-"),
    );
    cleanups.push(() => fs.rm(sandboxDir, { recursive: true, force: true }));
    const files = createFileAccess({
      command: "sh",
      args: ["-c", 'cd "$1" && shift && exec "$@"', "test-wrapper", sandboxDir],
    });
    const manager = createSubagentManager(
      new Map(),
      {
        onSubagentSwitched: () => {},
      },
      files,
    );
    assert.equal(
      manager.switchToSubagent("custom:test", "test", 0).success,
      true,
    );

    const memoryPath = path.join(AGENT_MEMORY_DIR, "report.md");
    const outside = path.join(sandboxDir, "outside.md");
    const outsideLink = path.join(AGENT_MEMORY_DIR, "outside-link.md");
    await fs.mkdir(path.join(sandboxDir, AGENT_MEMORY_DIR), {
      recursive: true,
    });
    await fs.writeFile(path.join(sandboxDir, memoryPath), "Sandbox report");
    await fs.writeFile(outside, "Outside memory");
    await fs.symlink(outside, path.join(sandboxDir, outsideLink));

    // when:
    const compacted = await readMemoryForCompaction(
      { memoryPath, reason: "test" },
      files,
    );
    const report = await manager.switchToMainAgent({ memoryPath });
    const rejectedCompaction = await readMemoryForCompaction(
      { memoryPath: outsideLink, reason: "test" },
      files,
    );
    const rejectedReport = await manager.switchToMainAgent({
      memoryPath: outsideLink,
    });

    // then:
    assert.match(String(compacted), /Sandbox report/);
    assert.deepEqual(report, {
      success: true,
      memoryContent: "Sandbox report",
    });
    assert.ok(rejectedCompaction instanceof Error);
    assert.match(rejectedCompaction.message, /Access denied/);
    assert.ok(!rejectedReport.success);
    assert.match(rejectedReport.error ?? "", /Access denied/);
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
