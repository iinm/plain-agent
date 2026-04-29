import assert from "node:assert";
import test, { describe } from "node:test";
import { createMCPClient, MCPClient, StdioTransport } from "./mcpClient.mjs";

const MOCK_SERVER_PATH = new URL(
  "./mcpClient.test.mockServer.mjs",
  import.meta.url,
).pathname;

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

describe("MCPClient", () => {
  test("initializes successfully", async () => {
    // given:
    const transport = new StdioTransport(process.execPath, [MOCK_SERVER_PATH]);
    const client = new MCPClient(transport);

    // when:
    const initResult = await client.initialize();

    // then:
    assert.equal(initResult.protocolVersion, "2025-03-26");
    assert.equal(initResult.serverInfo.name, "mock");

    await client.close();
  });

  test("lists available tools", async () => {
    // given:
    const transport = new StdioTransport(process.execPath, [MOCK_SERVER_PATH]);
    const client = new MCPClient(transport);
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
    const transport = new StdioTransport(process.execPath, [MOCK_SERVER_PATH]);
    const client = new MCPClient(transport);
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
    const transport = new StdioTransport(process.execPath, [MOCK_SERVER_PATH]);
    const client = new MCPClient(transport);
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
    const transport = new StdioTransport(process.execPath, [MOCK_SERVER_PATH]);
    const client = new MCPClient(transport);
    await client.initialize();

    // when:
    await client.close();

    // then:
    assert.ok(true);
  });

  test("rejects pending requests on JSON-RPC error", async () => {
    // given:
    const transport = new StdioTransport(process.execPath, [MOCK_SERVER_PATH]);
    const client = new MCPClient(transport);
    await client.initialize();

    // when:
    const promise = client.callTool({ name: "error_tool", arguments: {} });

    // then:
    await assert.rejects(() => promise, { message: "tool failed" });

    await client.close();
  });

  test("rejects pending requests when server exits", async () => {
    // given:
    const transport = new StdioTransport(process.execPath, [MOCK_SERVER_PATH]);
    const client = new MCPClient(transport);
    await client.initialize();

    // when:
    const toolPromise = client.listTools();
    transport.process.kill();

    // then:
    await assert.rejects(() => toolPromise, /MCP server exited/);
  });

  test("rejects requests after close", async () => {
    // given:
    const transport = new StdioTransport(process.execPath, [MOCK_SERVER_PATH]);
    const client = new MCPClient(transport);
    await client.initialize();
    await client.close();

    // when/then:
    await assert.rejects(() => client.listTools(), /MCP client is closed/);
  });

  test("rejects pending requests on error event", async () => {
    // given:
    const transport = new StdioTransport(process.execPath, [MOCK_SERVER_PATH]);
    const client = new MCPClient(transport);
    await client.initialize();

    // when:
    const toolPromise = client.listTools();
    const testError = new Error("test error");
    transport.process.emit("error", testError);

    // then:
    await assert.rejects(() => toolPromise, /test error/);
    transport.process.kill();
  });
});

describe("StdioTransport", () => {
  test("request times out when server does not respond", async () => {
    // given: a server that never responds
    const transport = new StdioTransport(process.execPath, [
      "-e",
      "setTimeout(() => {}, 60000)",
    ]);

    // when/then:
    await assert.rejects(() => transport.request("test", {}, 100), /timed out/);

    await transport.close();
  });
});
