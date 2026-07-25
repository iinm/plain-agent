/**
 * @import { Agent, AgentConfig, AgentEvent, AgentInput } from "./agent"
 * @import { PauseSignal } from "./agentLoop.mjs";
 * @import { SystemMessage } from "./model"
 * @import { Tool, ToolDefinition } from "./tool"
 * @import { CompactContextInput } from "./tools/compactContext"
 * @import { SwitchToSubagentInput } from "./tools/switchToSubagent"
 * @import { SwitchToMainAgentInput } from "./tools/switchToMainAgent"
 * @import { AsyncQueue } from "./utils/createAsyncQueue.mjs"
 */

import { createAgentLoop } from "./agentLoop.mjs";
import { createStateManager } from "./agentState.mjs";
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
  sessionMetadata,
  initialState,
  contextSoftLimit,
  inputTokensKeys,
}) {
  /** @type {AsyncQueue<AgentInput>} */
  const inputQueue = createAsyncQueue();
  /** @type {AsyncQueue<AgentEvent>} */
  const eventQueue = createAsyncQueue();

  /** @type {SystemMessage} */
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
        eventQueue.push({ timestamp: new Date(), type: "message", message });
      }
    },
    onMessagesReplaced: (messages) =>
      eventQueue.push({
        timestamp: new Date(),
        type: "messages_reset",
        messages,
      }),
  });

  const subagentManager = createSubagentManager(agentRoles, {
    onSubagentSwitched: (subagent) => {
      eventQueue.push({
        timestamp: new Date(),
        type: "subagent_switched",
        subagent,
      });
    },
  });

  if (initialState) {
    subagentManager.restoreState(initialState.subagentState);
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
  /** @type {PauseSignal} */
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
    emitEvent: (event) => eventQueue.push(event),
    toolUseApprover,
    subagentManager,
    pauseSignal,
    contextSoftLimit,
    inputTokensKeys,
  });

  let sessionStartEmitted = false;
  const emitSessionStartOnce = () => {
    if (sessionStartEmitted) return;
    sessionStartEmitted = true;
    eventQueue.push({
      timestamp: new Date(),
      type: "session_start",
      sessionFormatVersion: SESSION_FORMAT_VERSION,
      sessionId: sessionMetadata.sessionId,
      modelName: sessionMetadata.modelName,
      workingDir: sessionMetadata.workingDir,
      startTime: sessionMetadata.startTime.toISOString(),
    });
    eventQueue.push({
      timestamp: new Date(),
      type: "messages_reset",
      messages: stateManager.getMessages(),
    });
  };

  let inputLoopStarted = false;
  const startInputLoopOnce = () => {
    if (inputLoopStarted) return;
    inputLoopStarted = true;
    (async () => {
      for await (const input of inputQueue) {
        await agentLoop.handleUserInput(input);
      }
    })().catch((err) => {
      eventQueue.push({
        timestamp: new Date(),
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });
  };

  return {
    start() {
      startInputLoopOnce();
      return eventQueue;
    },
    send(input) {
      emitSessionStartOnce();
      inputQueue.push(input);
    },
    stop() {
      inputQueue.close();
      eventQueue.close();
    },
    pauseAutoApprove: () => {
      paused = true;
    },
    getActiveSubagent: () => {
      const active = subagentManager.getActiveSubagent();
      return active ? { name: active.name } : null;
    },
  };
}
