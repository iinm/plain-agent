/**
 * Mock MCP server for testing.
 * Speaks JSON-RPC 2.0 over stdio.
 * Handles: initialize, notifications/initialized, tools/list, tools/call.
 */

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    respond(msg.id, {
      protocolVersion: "2025-03-26",
      capabilities: {},
      serverInfo: { name: "mock", version: "0.0.0" },
    });
    return;
  }

  if (msg.method === "notifications/initialized") {
    return;
  }

  if (msg.method === "tools/list") {
    respond(msg.id, {
      tools: [
        {
          name: "echo",
          description: "Echo tool",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
          },
        },
        {
          name: "add",
          description: "Add numbers",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
          },
        },
      ],
    });
    return;
  }

  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "echo") {
      respond(msg.id, { content: [{ type: "text", text: args.text }] });
    } else if (name === "add") {
      respond(msg.id, {
        content: [{ type: "text", text: String(args.a + args.b) }],
      });
    } else if (name === "error_tool") {
      respondError(msg.id, -1, "tool failed");
    }
  }
});

/** @param {number} id @param {unknown} result */
function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

/** @param {number} id @param {number} code @param {string} message */
function respondError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}
