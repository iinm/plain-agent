/**
 * @import { Agent, AgentConfig, AgentEventEmitter, UserEventEmitter } from "./agent"
 * @import { Tool, ToolDefinition } from "./tool"
 * @import { CompactContextInput } from "./tools/compactContext"
 * @import { SwitchToSubagentInput } from "./tools/switchToSubagent"
 * @import { SwitchToMainAgentInput } from "./tools/switchToMainAgent"
 */

import { EventEmitter } from "node:events";
import { styleText } from "node:util";
import { createAgentLoop } from "./agentLoop.mjs";
import { createStateManager } from "./agentState.mjs";
import { createCostTracker } from "./costTracker.mjs";
import { SESSION_FILE_VERSION, saveSession } from "./sessionStore.mjs";
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
  sessionMetadata,
  initialState,
}) {
  /** @type {UserEventEmitter} */
  const userEventEmitter = new EventEmitter();
  /** @type {AgentEventEmitter} */
  const agentEventEmitter = new EventEmitter();

  const costTracker = createCostTracker(modelCostConfig);

  agentEventEmitter.on("providerTokenUsage", (usage) => {
    costTracker.recordUsage(usage);
  });

  // Build the initial message list. When resuming, replace messages[0] with
  // the freshly built system prompt (today/agent roles/skills may have
  // changed) but keep the rest of the saved conversation verbatim.
  /** @type {import("./model").SystemMessage} */
  const systemMessage = {
    role: "system",
    content: [{ type: "text", text: prompt }],
  };
  const baseMessages = initialState?.messages?.length
    ? [systemMessage, ...initialState.messages.slice(1)]
    : [systemMessage];

  const stateManager = createStateManager(baseMessages, {
    onMessagesAppended: (newMessages) => {
      const lastMessage = newMessages.at(-1);
      if (lastMessage) {
        agentEventEmitter.emit("message", lastMessage);
      }
      schedulePersist();
    },
  });

  const subagentManager = createSubagentManager(agentRoles, {
    onSubagentSwitched: (subagent) => {
      agentEventEmitter.emit("subagentSwitched", subagent);
    },
  });

  // Restore the rest of the session state. Subagent restoration is silent
  // (no event), since CLI listeners aren't attached yet — the CLI consults
  // getActiveSubagent() at startup instead.
  if (initialState) {
    subagentManager.restoreState(initialState.subagentState);
    toolUseApprover.restoreAllowedToolUseInSession(
      initialState.allowedToolUseInSession,
    );
    costTracker.restoreUsageHistory(initialState.tokenUsageHistory);
  }

  /** @type {Promise<void>} */
  let persistChain = Promise.resolve();
  function schedulePersist() {
    persistChain = persistChain.then(async () => {
      try {
        await saveSession({
          version: SESSION_FILE_VERSION,
          sessionId: sessionMetadata.sessionId,
          modelName: sessionMetadata.modelName,
          workingDir: sessionMetadata.workingDir,
          startTime: sessionMetadata.startTime.toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          messages: stateManager.getMessages(),
          subagentState: subagentManager.getState(),
          allowedToolUseInSession: toolUseApprover.getAllowedToolUseInSession(),
          tokenUsageHistory: costTracker.getUsageHistory(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          styleText(
            "yellow",
            `Warning: failed to persist session state: ${message}`,
          ),
        );
      }
    });
  }

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
      getCostSummary: () => costTracker.calculateCost(),
      pauseAutoApprove: () => {
        paused = true;
      },
      getActiveSubagent: () => subagentManager.getActiveSubagent(),
      flushSessionPersistence: async () => {
        await persistChain;
      },
    },
  };
}
