/**
 * @import { Tool, ToolImplementation } from '../tool'
 * @import { CompactContextInput } from './compactContext'
 */

import { createFileAccess, MEMORY_TARGET } from "../fileAccess.mjs";
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
    fileTarget: MEMORY_TARGET,
    def: {
      name: compactContextToolName,
      description:
        "Discard prior messages and reload task state from a memory file.",
      inputSchema: {
        type: "object",
        properties: {
          memoryPath: {
            type: "string",
            description: "Path to the memory file.",
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
 * @param {import("../fileAccess.mjs").FileAccess} [files]
 * @param {import("../fileAccess.mjs").FileTarget} [target]
 * @returns {Promise<string | Error>}
 */
export async function readMemoryForCompaction(input, files, target) {
  const backend = files ?? createFileAccess();
  return await noThrow(async () => {
    const resolved =
      target ?? (await backend.resolveToolTarget(input, MEMORY_TARGET));
    const memoryContent = (await backend.readFile(resolved.realPath)).toString(
      "utf8",
    );

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
