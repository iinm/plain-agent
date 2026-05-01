/**
 * @import { Agent, AgentConfig, AgentEventEmitter, UserEventEmitter } from "./agent"
 * @import { Tool, ToolDefinition } from "./tool"
 * @import { CompactContextInput } from "./tools/compactContext"
 * @import { SwitchToSubagentInput } from "./tools/switchToSubagent"
 * @import { SwitchToMainAgentInput } from "./tools/switchToMainAgent"
 */

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createAgentLoop } from "./agentLoop.mjs";
import { createStateManager } from "./agentState.mjs";
import { createCostTracker } from "./costTracker.mjs";
import { MESSAGES_DUMP_FILE_PATH } from "./env.mjs";
import { createSubagentManager } from "./subagent.mjs";
import { createToolExecutor } from "./toolExecutor.mjs";
import {
  compactContextToolName,
  readMemoryForCompaction,
} from "./tools/compactContext.mjs";
import { switchToMainAgentToolName } from "./tools/switchToMainAgent.mjs";
import { switchToSubagentToolName } from "./tools/switchToSubagent.mjs";

/**
 * @param {AgentConfig} config
 * @returns {Agent}
 */
export function createAgent({
  callModel,
  prompt,
  tools,
  toolUseApprover,
  agentRoles,
  modelCostConfig,
}) {
  /** @type {UserEventEmitter} */
  const userEventEmitter = new EventEmitter();
  /** @type {AgentEventEmitter} */
  const agentEventEmitter = new EventEmitter();

  const costTracker = createCostTracker(modelCostConfig);

  agentEventEmitter.on("providerTokenUsage", (usage) => {
    costTracker.recordUsage(usage);
  });

  const stateManager = createStateManager(
    [
      {
        role: "system",
        content: [{ type: "text", text: prompt }],
      },
    ],
    {
      onMessagesAppended: (newMessages) => {
        const lastMessage = newMessages.at(-1);
        if (!lastMessage) {
          return;
        }
        agentEventEmitter.emit("message", lastMessage);
      },
    },
  );

  const subagentManager = createSubagentManager(agentRoles, {
    onSubagentSwitched: (subagent) => {
      agentEventEmitter.emit("subagentSwitched", subagent);
    },
  });

  /**
   * @param {SwitchToSubagentInput} input
   */
  const switchToSubagentImpl = async (input) => {
    const result = subagentManager.switchToSubagent(
      input.name,
      input.goal,
      stateManager.getMessages().length - 1,
    );
    if (!result.success) {
      return new Error(result.error);
    }
    return result.value;
  };

  /**
   * @param {SwitchToMainAgentInput} input
   */
  const switchToMainAgentImpl = async (input) => {
    const result = await subagentManager.switchToMainAgent(input.memoryPath);
    if (!result.success) {
      return new Error(result.error);
    }
    return result.memoryContent;
  };

  /**
   * @param {Record<string, unknown>} rawInput
   */
  const compactContextImpl = async (rawInput) => {
    if (subagentManager.isSubagentActive()) {
      return new Error(
        "compact_context cannot be used while running as a subagent. " +
          "Call switch_to_main_agent to return to the main agent first.",
      );
    }
    const input = /** @type {CompactContextInput} */ (rawInput);
    return await readMemoryForCompaction(input);
  };

  /** @type {Map<string, Tool>} */
  const toolByName = new Map();
  for (const tool of tools) {
    if (tool.def.name === switchToSubagentToolName && tool.injectImpl) {
      tool.injectImpl(switchToSubagentImpl);
    }
    if (tool.def.name === switchToMainAgentToolName && tool.injectImpl) {
      tool.injectImpl(switchToMainAgentImpl);
    }
    if (tool.def.name === compactContextToolName && tool.injectImpl) {
      tool.injectImpl(compactContextImpl);
    }
    toolByName.set(tool.def.name, tool);
  }

  /** @type {ToolDefinition[]} */
  const toolDefs = tools.map(({ def }) => def);

  const toolExecutor = createToolExecutor(toolByName, {
    exclusiveToolNames: [switchToSubagentToolName, switchToMainAgentToolName],
  });

  async function dumpMessages() {
    const filePath = MESSAGES_DUMP_FILE_PATH;
    try {
      await fs.writeFile(
        filePath,
        JSON.stringify(stateManager.getMessages(), null, 2),
      );
      console.log(`Messages dumped to ${filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error dumping messages: ${message}`);
    }
  }

  async function loadMessages() {
    const filePath = MESSAGES_DUMP_FILE_PATH;
    try {
      const data = await fs.readFile(filePath, "utf-8");
      const loadedMessages = JSON.parse(data);
      if (Array.isArray(loadedMessages)) {
        // Keep the system message (index 0) and replace the rest
        stateManager.setMessages([
          stateManager.getMessageAt(0),
          ...loadedMessages.slice(1),
        ]);
        console.log(`Messages loaded from ${filePath}`);
      } else {
        console.error("Error loading messages: Invalid format in file.");
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error loading messages: ${error.message}`);
      }
    }
  }

  // Pause signal: set by Ctrl-C during agent execution, checked after each tool batch completes
  let paused = false;
  /** @type {import("./agentLoop.mjs").PauseSignal} */
  const pauseSignal = {
    isPaused: () => paused,
    reset: () => {
      paused = false;
    },
  };

  const agentLoop = createAgentLoop({
    callModel,
    stateManager,
    toolDefs,
    toolExecutor,
    agentEventEmitter,
    toolUseApprover,
    subagentManager,
    pauseSignal,
  });

  userEventEmitter.on("userInput", agentLoop.handleUserInput);

  return {
    userEventEmitter,
    agentEventEmitter,
    agentCommands: {
      dumpMessages,
      loadMessages,
      getCostSummary: () => costTracker.calculateCost(),
      pauseAutoApprove: () => {
        paused = true;
      },
    },
  };
}
