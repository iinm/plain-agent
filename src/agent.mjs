/**
 * @import { Agent, AgentConfig, AgentEvent, AgentInput } from "./agent"
 * @import { Tool, ToolDefinition } from "./tool"
 * @import { CompactContextInput } from "./tools/compactContext"
 * @import { SwitchToSubagentInput } from "./tools/switchToSubagent"
 * @import { SwitchToMainAgentInput } from "./tools/switchToMainAgent"
 * @import { AsyncQueue } from "./utils/createAsyncQueue.mjs"
 */

import { createAgentLoop } from "./agentLoop.mjs";
import { createStateManager } from "./agentState.mjs";
import { createCostTracker } from "./costTracker.mjs";
import { SESSION_FORMAT_VERSION } from "./sessionStore.mjs";
import { createSubagentManager } from "./subagent.mjs";
import { createToolExecutor } from "./toolExecutor.mjs";
import {
  compactContextToolName,
  readMemoryForCompaction,
} from "./tools/compactContext.mjs";
import { switchToMainAgentToolName } from "./tools/switchToMainAgent.mjs";
import { switchToSubagentToolName } from "./tools/switchToSubagent.mjs";
import { createAsyncQueue } from "./utils/createAsyncQueue.mjs";

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
  contextSoftLimit,
  inputTokensKeys,
}) {
  /**
   * Pull-based input queue. CLI callers push input via send(); the
   * agent's run loop consumes it as an async iterable.
   * @type {AsyncQueue<AgentInput>}
   */
  const inputQueue = createAsyncQueue();
  /**
   * Output stream of agent events, yielded by run().
   * @type {AsyncQueue<AgentEvent>}
   */
  const eventQueue = createAsyncQueue();

  const costTracker = createCostTracker(modelCostConfig);

  /**
   * Emit an agent event onto the output stream. token_usage events are
   * also recorded by the cost tracker as they pass through.
   * @param {AgentEvent} event
   */
  const emitEvent = (event) => {
    if (event.type === "token_usage") {
      costTracker.recordUsage(event.usage);
    }
    eventQueue.push(event);
  };

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
      for (const message of newMessages) {
        emitEvent({ type: "message", message });
      }
    },
    onMessagesReplaced: (messages) =>
      emitEvent({ type: "messages_reset", messages }),
  });

  const subagentManager = createSubagentManager(agentRoles, {
    onSubagentSwitched: (subagent) => {
      emitEvent({ type: "subagent_switched", subagent });
    },
  });

  // Restore the rest of the session state. Subagent restoration is silent
  // (no event), since CLI listeners aren't attached yet — the CLI consults
  // getActiveSubagent() at startup instead.
  if (initialState) {
    subagentManager.restoreState(initialState.subagentState);
    costTracker.restoreUsageHistory(initialState.tokenUsageHistory);
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
    emitEvent,
    toolUseApprover,
    subagentManager,
    pauseSignal,
    contextSoftLimit,
    inputTokensKeys,
  });

  // Drive the agent by consuming user input from the pull-based queue and
  // running one turn loop per input. Runs for the lifetime of the process.
  let inputLoopStarted = false;
  let sessionStartEmitted = false;
  const emitSessionStartOnce = () => {
    if (sessionStartEmitted) return;
    sessionStartEmitted = true;
    emitEvent({
      type: "session_start",
      sessionFormatVersion: SESSION_FORMAT_VERSION,
      sessionId: sessionMetadata.sessionId,
      modelName: sessionMetadata.modelName,
      workingDir: sessionMetadata.workingDir,
      startTime: sessionMetadata.startTime.toISOString(),
    });
    emitEvent({
      type: "messages_reset",
      messages: stateManager.getMessages(),
    });
  };
  const startInputLoop = () => {
    if (inputLoopStarted) return;
    inputLoopStarted = true;
    (async () => {
      for await (const input of inputQueue) {
        await agentLoop.handleUserInput(input);
      }
    })().catch((err) => {
      emitEvent({
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });
  };

  return {
    start() {
      startInputLoop();
      return eventQueue;
    },
    send(input) {
      emitSessionStartOnce();
      inputQueue.push(input);
    },
    getCostSummary: () => costTracker.calculateCost(),
    pauseAutoApprove: () => {
      paused = true;
    },
    getActiveSubagent: () => {
      const active = subagentManager.getActiveSubagent();
      return active ? { name: active.name } : null;
    },
  };
}
