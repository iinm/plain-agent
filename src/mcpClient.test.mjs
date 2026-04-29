import assert from "node:assert";
import { spawn } from "node:child_process";
import test, { describe } from "node:test";
import { MCPClient } from "./mcpClient.mjs";

const MOCK_SERVER_PATH = new URL(
  "./mcpClient.test.mockServer.mjs",
  import.meta.url,
).pathname;

/**
 * Spawn a mock MCP server that speaks JSON-RPC 2.0 over stdio.
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnMockServer() {
  return spawn(process.execPath, [MOCK_SERVER_PATH], {
    stdio: ["pipe", "pipe", "ignore"],
  });
}

describe("MCPClient", () => {
  test("initialize, listTools, callTool, close", async () => {
    const proc = spawnMockServer();
    const client = new MCPClient(proc);

    const initResult = await client.initialize();
    assert.equal(initResult.protocolVersion, "2025-03-26");
    assert.equal(initResult.serverInfo.name, "mock");

    const { tools } = await client.listTools();
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "echo");
    assert.equal(tools[1].name, "add");

    const echoResult = await client.callTool({
      name: "echo",
      arguments: { text: "hello" },
    });
    assert.deepStrictEqual(echoResult.content, [
      { type: "text", text: "hello" },
    ]);

    const addResult = await client.callTool({
      name: "add",
      arguments: { a: 2, b: 3 },
    });
    assert.deepStrictEqual(addResult.content, [{ type: "text", text: "5" }]);

    await client.close();
  });

  test("rejects pending requests on JSON-RPC error", async () => {
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();

    await assert.rejects(
      () => client.callTool({ name: "error_tool", arguments: {} }),
      { message: "tool failed" },
    );

    await client.close();
  });

  test("rejects pending requests when server exits", async () => {
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();

    // Kill the server while a request is in flight
    const toolPromise = client.listTools();
    proc.kill();

    await assert.rejects(() => toolPromise, /MCP server exited/);
  });

  test("throws if stdout is not available", () => {
    const proc = spawn(process.execPath, ["-e", ""], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    assert.throws(() => new MCPClient(proc), {
      message: "MCP server stdout is not available",
    });
    proc.kill();
  });
});
