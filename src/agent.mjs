/**
 * @import { Agent, AgentConfig, AgentEvent, AgentInput } from "./agent"
 * @import { Tool, ToolDefinition } from "./tool"
 * @import { CompactContextInput } from "./tools/compactContext"
 * @import { SwitchToSubagentInput } from "./tools/switchToSubagent"
 * @import { SwitchToMainAgentInput } from "./tools/switchToMainAgent"
 * @import { AsyncQueue } from "./utils/createAsyncQueue.mjs"
 */

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
   * Emit an agent event onto the output stream. providerTokenUsage events are
   * also recorded by the cost tracker as they pass through.
   * @param {AgentEvent} event
   */
  const emitEvent = (event) => {
    if (event.type === "providerTokenUsage") {
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

  // Thin adapter over the state manager's structural notifications: an
  // "append" surfaces the newest message to listeners; both kinds persist.
  // The state manager itself knows nothing about emitting or persisting.
  const stateManager = createStateManager(baseMessages, {
    onMessagesChanged: (change) => {
      if (change.kind === "append") {
        const lastMessage = change.messages.at(-1);
        if (lastMessage) {
          emitEvent({ type: "message", message: lastMessage });
        }
      }
      schedulePersist();
    },
  });

  const subagentManager = createSubagentManager(agentRoles, {
    onSubagentSwitched: (subagent) => {
      emitEvent({ type: "subagentSwitched", subagent });
    },
  });

  // Restore the rest of the session state. Subagent restoration is silent
  // (no event), since CLI listeners aren't attached yet — the CLI consults
  // getActiveSubagent() at startup instead.
  if (initialState) {
    subagentManager.restoreState(
      initialState.subagentState,
      stateManager.reviveMarker,
    );
    toolUseApprover.restoreAllowedToolUseInSession(
      initialState.allowedToolUseInSession,
    );
    costTracker.restoreUsageHistory(initialState.tokenUsageHistory);
  }

  /** @type {Promise<void>} */
  let persistChain = Promise.resolve();
  /** Whether the session has ever been written to disk. */
  let sessionPersisted = false;
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
          subagentState: subagentManager.getState(stateManager.serializeMarker),
          allowedToolUseInSession: toolUseApprover.getAllowedToolUseInSession(),
          tokenUsageHistory: costTracker.getUsageHistory(),
        });
        sessionPersisted = true;
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
      stateManager.markCheckpoint,
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
      inputQueue.push(input);
    },
    getCostSummary: () => costTracker.calculateCost(),
    pauseAutoApprove: () => {
      paused = true;
    },
    getActiveSubagent: () => subagentManager.getActiveSubagent(),
    flushSessionPersistence: async () => {
      await persistChain;
      return sessionPersisted;
    },
  };
}
