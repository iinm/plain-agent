/**
 * @import { Agent, AgentConfig, AgentEvent } from "../../agent"
 * @import { Tool, ToolUseApprover } from "../../tool"
 * @import { CallModel, Message } from "../../model"
 */

/**
 * @param {string} [toolUseId]
 * @returns {Message}
 */
export function createToolUseMessage(toolUseId = "t1") {
  return {
    role: "assistant",
    content: [{ type: "tool_use", toolUseId, toolName: "echo", input: {} }],
  };
}

/** @type {Message} */
export const toolUseMessage = createToolUseMessage();

/** @type {Message} */
export const textMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
};

/**
 * @param {Message[]} messages
 * @returns {CallModel}
 */
export function createScriptedCallModel(messages) {
  let index = 0;
  return async () => {
    const message = messages[Math.min(index, messages.length - 1)];
    index += 1;
    return { message };
  };
}

/**
 * @param {() => void} onImpl
 * @returns {Tool}
 */
export function createEchoTool(onImpl) {
  return {
    def: { name: "echo", description: "", inputSchema: {} },
    impl: async () => {
      onImpl();
      return "ok";
    },
  };
}

/**
 * @param {"allow" | "deny" | "ask"} action
 * @returns {ToolUseApprover}
 */
export function createApprover(action) {
  /** @type {{ toolName: string }[]} */
  const sessionAllowed = [];

  return {
    isAllowedToolUse: (toolUse) =>
      sessionAllowed.some((pattern) => pattern.toolName === toolUse.toolName)
        ? { action: "allow" }
        : { action },
    allowToolUse: (toolUse) => {
      sessionAllowed.push({ toolName: toolUse.toolName });
    },
    resetApprovalCount: () => {},
  };
}

/**
 * @param {Partial<AgentConfig>} overrides
 * @returns {AgentConfig}
 */
export function createBaseConfig(overrides) {
  return {
    callModel: createScriptedCallModel([toolUseMessage, textMessage]),
    prompt: "system",
    tools: [],
    toolUseApprover: createApprover("ask"),
    agentRoles: new Map(),
    sessionMetadata: {
      sessionId: "test",
      modelName: "test",
      workingDir: "/tmp",
      startTime: new Date(),
    },
    ...overrides,
  };
}

/**
 * @param {Agent} agent
 * @returns {Promise<AgentEvent[]>}
 */
export async function runAndCollect(agent) {
  const events = [];
  agent.send([{ type: "text", text: "hi" }]);
  for await (const event of agent.start()) {
    events.push(event);
    if (event.type === "turn_end") agent.stop();
  }
  return events;
}
