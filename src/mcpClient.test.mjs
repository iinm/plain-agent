import assert from "node:assert";
import { spawn } from "node:child_process";
import test, { describe } from "node:test";
import { createMCPClient, MCPClient } from "./mcpClient.mjs";

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
  test("initializes successfully", async () => {
    // given:
    const proc = spawnMockServer();
    const client = new MCPClient(proc);

    // when:
    const initResult = await client.initialize();

    // then:
    assert.equal(initResult.protocolVersion, "2025-03-26");
    assert.equal(initResult.serverInfo.name, "mock");

    await client.close();
  });

  test("lists available tools", async () => {
    // given:
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();

    // when:
    const { tools } = await client.listTools();

    // then:
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "echo");
    assert.equal(tools[1].name, "add");

    await client.close();
  });

  test("calls a tool and returns result", async () => {
    // given:
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();

    // when:
    const echoResult = await client.callTool({
      name: "echo",
      arguments: { text: "hello" },
    });

    // then:
    assert.deepStrictEqual(echoResult.content, [
      { type: "text", text: "hello" },
    ]);

    await client.close();
  });

  test("calls add tool and returns sum", async () => {
    // given:
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();

    // when:
    const addResult = await client.callTool({
      name: "add",
      arguments: { a: 2, b: 3 },
    });

    // then:
    assert.deepStrictEqual(addResult.content, [{ type: "text", text: "5" }]);

    await client.close();
  });

  test("closes without error", async () => {
    // given:
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();

    // when:
    await client.close();

    // then:
    assert.ok(true);
  });

  test("rejects pending requests on JSON-RPC error", async () => {
    // given:
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();

    // when:
    const promise = client.callTool({ name: "error_tool", arguments: {} });

    // then:
    await assert.rejects(() => promise, { message: "tool failed" });

    await client.close();
  });

  test("rejects pending requests when server exits", async () => {
    // given:
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();

    // when:
    const toolPromise = client.listTools();
    proc.kill();

    // then:
    await assert.rejects(() => toolPromise, /MCP server exited/);
  });

  test("throws if stdout is not available", () => {
    // given:
    const proc = spawn(process.execPath, ["-e", ""], {
      stdio: ["pipe", "ignore", "ignore"],
    });

    // when/then:
    assert.throws(() => new MCPClient(proc), {
      message: "MCP server stdout is not available",
    });

    proc.kill();
  });

  test("rejects requests after close", async () => {
    // given:
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();
    await client.close();

    // when/then:
    await assert.rejects(() => client.listTools(), /MCP client is closed/);
  });

  test("rejects pending requests on error event", async () => {
    // given:
    const proc = spawnMockServer();
    const client = new MCPClient(proc);
    await client.initialize();

    // when:
    const toolPromise = client.listTools();
    const testError = new Error("test error");
    proc.emit("error", testError);

    // then:
    await assert.rejects(() => toolPromise, /test error/);
    proc.kill();
  });
});

describe("createMCPClient", () => {
  test("spawns and initializes a client successfully", async () => {
    // given:
    const options = {
      command: process.execPath,
      args: [MOCK_SERVER_PATH],
    };

    // when:
    const client = await createMCPClient(options);

    // then:
    assert.ok(client instanceof MCPClient);

    await client.close();
  });

  test("rejects when command does not exist", async () => {
    // given:
    const options = {
      command: "nonexistent_command_12345",
    };

    // when/then:
    await assert.rejects(() => createMCPClient(options), /ENOENT/);
  });
});
