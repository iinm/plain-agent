/**
 * @import { Tool, ToolImplementation } from '../tool'
 */

export const switchToMainAgentToolName = "switch_to_main_agent";

/** @returns {Tool} */
export function createSwitchToMainAgentTool() {
  /** @type {ToolImplementation} */
  let impl = async () => {
    throw new Error("Not implemented");
  };

  /** @type {Tool} */
  const tool = {
    def: {
      name: switchToMainAgentToolName,
      description:
        "Switch back to the main agent role and report the result.",
      inputSchema: {
        type: "object",
        properties: {
          memoryPath: {
            type: "string",
            description:
              "Path to the memory file containing the result of the subagent's task.",
          },
        },
        required: ["memoryPath"],
      },
    },

    // Implementation will be injected by the agent to access its state
    get impl() {
      return impl;
    },

    injectImpl(fn) {
      impl = fn;
    },
  };

  return tool;
}
