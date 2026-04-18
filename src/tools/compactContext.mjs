/**
 * @import { Tool, ToolImplementation } from '../tool'
 * @import { CompactContextInput } from './compactContext'
 */

import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_MEMORY_DIR } from "../env.mjs";
import { noThrow } from "../utils/noThrow.mjs";

export const compactContextToolName = "compact_context";

/** @returns {Tool} */
export function createCompactContextTool() {
  /** @type {ToolImplementation} */
  let impl = async () => {
    throw new Error("Not implemented");
  };

  /** @type {Tool} */
  const tool = {
    def: {
      name: compactContextToolName,
      description:
        "Discard prior messages and reload task state from a memory file.",
      inputSchema: {
        type: "object",
        properties: {
          memoryPath: {
            type: "string",
            description: `Path to the memory file under ${AGENT_MEMORY_DIR}/.`,
          },
          reason: {
            type: "string",
            description: "The reason for compacting the context.",
          },
        },
        required: ["memoryPath", "reason"],
      },
    },

    // Implementation is injected by the agent so it can access subagent
    // state (compact_context is not allowed during subagent execution).
    get impl() {
      return impl;
    },

    injectImpl(fn) {
      impl = fn;
    },
  };

  return tool;
}

/**
 * Read a memory file and return the compact_context tool result string.
 * Validates that the memoryPath is within the project memory directory.
 * @param {CompactContextInput} input
 * @returns {Promise<string | Error>}
 */
export async function readMemoryForCompaction(input) {
  return await noThrow(async () => {
    const absolutePath = path.resolve(input.memoryPath);
    const memoryDir = path.resolve(AGENT_MEMORY_DIR);
    const relativePath = path.relative(memoryDir, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Error(
        `Access denied: memoryPath must be within ${AGENT_MEMORY_DIR}`,
      );
    }

    const memoryContent = await fs.readFile(absolutePath, {
      encoding: "utf-8",
    });

    return [
      "Context compacted. Prior conversation has been discarded.",
      `Reason: ${input.reason}`,
      `Memory file: ${input.memoryPath}`,
      "",
      "Resume the task using the memory file contents below.",
      "",
      memoryContent,
    ].join("\n");
  });
}
