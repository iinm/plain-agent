/**
 * @import { StructuredToolResultContent, Tool, ToolImplementation } from "./tool";
 * @import { MCPServerConfig } from "./config";
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AGENT_PROJECT_METADATA_DIR } from "./env.mjs";
import { createMCPClient } from "./mcpClient.mjs";
import { writeTmpFile } from "./tmpfile.mjs";
import { noThrow } from "./utils/noThrow.mjs";

/** @typedef {import("./mcpClient.mjs").MCPClient} MCPClient */

const OUTPUT_MAX_LENGTH = 1024 * 8;

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
 * @typedef {Object} MCPServerOptions
 * @property {string} serverName
 * @property {{ command: string, args?: string[], env?: Record<string, string> }} params
 */

/**
 * @param {MCPServerOptions} options
 * @returns {Promise<{client: MCPClient; stderrLogPath: string; cleanup: () => void}>}
 */
async function startMCPServer(options) {
  // Ensure log directory exists and open stderr log file
  const logDir = path.join(AGENT_PROJECT_METADATA_DIR, "logs");
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `mcp--${options.serverName}.stderr`);

  const client = await createMCPClient({
    ...options.params,
    stderr: logPath,
  });

  return {
    client,
    stderrLogPath: logPath,
    cleanup: () => {},
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
