/**
 * @import { Tool, ToolImplementation } from '../tool'
 */

export const switchToSubagentToolName = "switch_to_subagent";

/** @returns {Tool} */
export function createSwitchToSubagentTool() {
  /** @type {ToolImplementation} */
  let impl = async () => {
    throw new Error("Not implemented");
  };

  /** @type {Tool} */
  const tool = {
    def: {
      name: switchToSubagentToolName,
      description:
        "Switch to a subagent role within the same conversation, focusing on the specified goal. You inherit the current context.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Role or name of the subagent. Use 'custom:' prefix for ad-hoc roles.",
          },
          goal: {
            type: "string",
            description: "The goal or task for the subagent to achieve.",
          },
        },
        required: ["name", "goal"],
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
