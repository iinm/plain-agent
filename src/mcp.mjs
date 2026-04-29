/**
 * @import { StructuredToolResultContent, Tool, ToolImplementation } from "./tool";
 * @import { MCPServerConfig } from "./config";
 */

import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { AGENT_PROJECT_METADATA_DIR } from "./env.mjs";
import { writeTmpFile } from "./tmpfile.mjs";
import { noThrow } from "./utils/noThrow.mjs";

const OUTPUT_MAX_LENGTH = 1024 * 8;

// --- Minimal MCP Client (JSON-RPC 2.0 over stdio) ---

class MCPClient {
  /** @type {import("node:child_process").ChildProcess} */
  #process;
  /** @type {import("node:readline").Interface} */
  #rl;
  #nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (reason: any) => void }>} */
  #pendingRequests = new Map();

  /**
   * @param {import("node:child_process").ChildProcess} childProcess
   */
  constructor(childProcess) {
    this.#process = childProcess;
    if (!childProcess.stdout) {
      throw new Error("MCP server stdout is not available");
    }
    this.#rl = createInterface({ input: childProcess.stdout });
    this.#rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if ("id" in msg && this.#pendingRequests.has(msg.id)) {
          const pending = this.#pendingRequests.get(msg.id);
          if (!pending) return;
          this.#pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(
              new Error(msg.error.message || JSON.stringify(msg.error)),
            );
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    childProcess.on("close", (code) => {
      for (const [, { reject }] of this.#pendingRequests) {
        reject(new Error(`MCP server exited with code ${code}`));
      }
      this.#pendingRequests.clear();
    });

    childProcess.on("error", (err) => {
      for (const [, { reject }] of this.#pendingRequests) {
        reject(err);
      }
      this.#pendingRequests.clear();
    });
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  #request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.#process.stdin?.write(`${msg}\n`, (err) => {
        if (err) {
          this.#pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  #notify(method, params) {
    const msg = JSON.stringify(
      params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method },
    );
    this.#process.stdin?.write(`${msg}\n`);
  }

  async initialize() {
    const result = await this.#request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "plain-agent", version: "0.0.0" },
    });
    this.#notify("notifications/initialized");
    return result;
  }

  /**
   * @returns {Promise<{ tools: Array<{ name: string, description?: string, inputSchema: Record<string, unknown> }> }>}
   */
  async listTools() {
    return await this.#request("tools/list", {});
  }

  /**
   * @param {{ name: string, arguments?: Record<string, unknown> }} params
   * @returns {Promise<{ content?: Array<{ type: string, text?: string, data?: string, mimeType?: string }>, isError?: boolean }>}
   */
  async callTool(params) {
    return await this.#request("tools/call", params);
  }

  async close() {
    this.#rl.close();
    this.#process.stdin?.end();
    this.#process.kill();
  }
}

// --- Setup and Tool Creation ---

/**
 * @typedef {Object} SetupMCPServrResult
 * @property {Tool[]} tools
 * @property {string} stderrLogPath
 * @property {() => Promise<void>} cleanup
 */

/**
 * @param {string} serverName
 * @param {MCPServerConfig} serverConfig
 * @returns {Promise<SetupMCPServrResult>}
 */
export async function setupMCPServer(serverName, serverConfig) {
  const { options, ...params } = serverConfig;

  const { client, stderrLogPath, cleanup } = await startMCPServer({
    serverName,
    params,
  });

  const tools = (await createMCPTools(serverName, client)).filter(
    (tool) =>
      !options?.enabledTools ||
      options.enabledTools.find((enabledToolName) =>
        tool.def.name.endsWith(`__${enabledToolName}`),
      ),
  );

  return {
    tools,
    stderrLogPath,
    cleanup: async () => {
      cleanup();
      await client.close();
    },
  };
}

/**
 * @typedef {Object} MCPClientOptions
 * @property {string} serverName
 * @property {{ command: string, args?: string[], env?: Record<string, string> }} params
 */

/**
 * @param {MCPClientOptions} options
 * @returns {Promise<{client: MCPClient; stderrLogPath: string; cleanup: () => void}>}
 */
async function startMCPServer(options) {
  const { env, ...restParams } = options.params;
  const defaultEnv = {
    PWD: process.env.PWD || "",
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
  };

  // Ensure log directory exists and open stderr log file
  const logDir = path.join(AGENT_PROJECT_METADATA_DIR, "logs");
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `mcp--${options.serverName}.stderr`);
  const stderrLogFile = await open(logPath, "a");

  const childProcess = spawn(restParams.command, restParams.args || [], {
    env: env ? { ...defaultEnv, ...env } : undefined,
    stdio: ["pipe", "pipe", stderrLogFile.fd],
  });

  const client = new MCPClient(childProcess);
  await client.initialize();

  return {
    client,
    stderrLogPath: logPath,
    cleanup: () => {
      stderrLogFile.close();
    },
  };
}

/**
 * @param {string} serverName
 * @param {MCPClient} client
 * @returns {Promise<Tool[]>}
 */
async function createMCPTools(serverName, client) {
  const { tools: mcpTools } = await client.listTools();
  /** @type {Tool[]} */
  const tools = mcpTools
    .filter((tool) => {
      // Remove unsupported tools
      return ![""].includes(tool.name);
    })
    .map((tool) => {
      return {
        def: {
          name: `mcp__${serverName}__${tool.name}`,
          description: tool.description || `${tool.name} tool`,
          inputSchema: tool.inputSchema,
        },

        /** @type {ToolImplementation} */
        impl: async (input) =>
          noThrow(async () => {
            const result = await client.callTool({
              name: tool.name,
              arguments: input,
            });

            const resultStringRaw = JSON.stringify(result, null, 2);

            /** @type {StructuredToolResultContent[]} */
            const contentParts = [];
            /** @type {string[]} */
            const contentStrings = [];
            let contentContainsImage = false;
            if (Array.isArray(result.content)) {
              for (const part of result.content) {
                if ("text" in part && typeof part.text === "string") {
                  contentParts.push({
                    type: "text",
                    text: part.text,
                  });
                  contentStrings.push(part.text);
                } else if (
                  part.type === "image" &&
                  typeof part.mimeType === "string" &&
                  typeof part.data === "string"
                ) {
                  contentParts.push({
                    type: "image",
                    data: part.data,
                    mimeType: part.mimeType,
                  });
                  contentContainsImage = true;
                } else {
                  console.error(
                    `Unsupported content part from MCP: ${JSON.stringify(part)}`,
                  );
                }
              }
            }

            if (contentContainsImage) {
              return contentParts;
            }

            const resultString = contentStrings.join("\n\n") || resultStringRaw;

            /** @type {string} */
            let formmatted = resultString;
            let fileExtension = "txt";

            try {
              const parsed = JSON.parse(resultString);
              formmatted = JSON.stringify(parsed, null, 2);
              fileExtension = "json";
            } catch {
              // not JSON
            }

            if (formmatted.length <= OUTPUT_MAX_LENGTH) {
              return formmatted;
            }

            const filePath = await writeTmpFile(
              formmatted,
              tool.name,
              fileExtension,
            );
            const lineCount = formmatted.split("\n").length;

            return [
              `Content is large (${resultString.length} characters, ${lineCount} lines) and saved to ${filePath}`,
              "Use exec_command tool to find relevant parts.",
            ].join("\n");
          }),
      };
    });

  return tools;
}
