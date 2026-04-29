import assert from "node:assert";
import { spawn } from "node:child_process";
import test, { describe } from "node:test";
import { MCPClient } from "./mcpClient.mjs";

/**
 * Spawn a mock MCP server that speaks JSON-RPC 2.0 over stdio.
 * The server handles: initialize, tools/list, tools/call.
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnMockServer() {
  return spawn(
    process.execPath,
    [
      "-e",
      `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock", version: "0.0.0" } }
    }) + "\\n");
  } else if (msg.method === "notifications/initialized") {
    // no response for notifications
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { tools: [
        { name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "add", description: "Add numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }
      ] }
    }) + "\\n");
  } else if (msg.method === "tools/call") {
    const toolName = msg.params.name;
    if (toolName === "echo") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: msg.params.arguments.text }] }
      }) + "\\n");
    } else if (toolName === "add") {
      const sum = msg.params.arguments.a + msg.params.arguments.b;
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: String(sum) }] }
      }) + "\\n");
    } else if (toolName === "error_tool") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        error: { code: -1, message: "tool failed" }
      }) + "\\n");
    }
  }
});
`,
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
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
