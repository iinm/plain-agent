/**
 * @import { AgentEventSink, AgentBudgetConfig } from "./agent"
 * @import { StateManager } from "./agentState.mjs"
 * @import { CallModel, MessageContentText, MessageContentImage, MessageContentToolResult, PartialMessageContent, UserMessage, MessageContentToolUse, ProviderTokenUsage } from "./model"
 * @import { ToolDefinition, ToolUseApprover } from "./tool"
 * @import { ToolExecutor } from "./toolExecutor.mjs";
 * @import { SubagentManager } from "./subagent.mjs"
 */

import { styleText } from "node:util";
import { buildCompactPrompt } from "./prompt.mjs";
import { compactContextToolName } from "./tools/compactContext.mjs";

/**
 * @typedef {Object} PauseSignal
 * @property {() => boolean} isPaused - Returns true if auto-approve should be paused
 * @property {() => void} reset - Resets the paused state
 */

/**
 * @typedef {Object} AgentLoopConfig
 * @property {CallModel} callModel - Function to call the language model
 * @property {StateManager} stateManager - State manager for message handling
 * @property {ToolDefinition[]} toolDefs - Tool definitions for the model
 * @property {ToolExecutor} toolExecutor - Tool executor instance
 * @property {AgentEventSink} emitEvent - Sink that pushes agent events onto the output stream
 * @property {ToolUseApprover} toolUseApprover - Tool use approval checker
 * @property {SubagentManager} subagentManager - Subagent manager instance
 * @property {PauseSignal} pauseSignal - Signal to pause auto-approve after current tool completes
 * @property {number} [contextSoftLimit] - Soft limit on input tokens for auto-compact
 * @property {string[]} [inputTokensKeys] - Keys in providerTokenUsage to sum for input token count
 * @property {AgentBudgetConfig} [budget]
 */

/**
 * @typedef {ReturnType<typeof createAgentLoop>} AgentLoop
 */

/**
 * Create an agent loop handler
 * @param {AgentLoopConfig} config
 */
export function createAgentLoop({
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
  budget,
}) {
  const loopCreatedAt = new Date();
  const state = {
    turns: 0,
    turnsAfterBudgetSoftLimitPrompt: -1,
  };

  const inputHandler = createInputHandler({
    stateManager,
    toolExecutor,
    subagentManager,
    toolUseApprover,
  });

  /**
   * Handle user input and run the agent turn loop
   * @param {(MessageContentText | MessageContentImage)[]} input - User input content
   * @returns {Promise<void>}
   */
  async function handleUserInput(input) {
    pauseSignal.reset();
    toolUseApprover.resetApprovalCount();
    await inputHandler.handle(input);
    await runTurnLoop();
    emitEvent({ timestamp: new Date(), type: "turn_end" });
  }

  /**
   * Run the main agent turn loop
   * @returns {Promise<void>}
   */
  async function runTurnLoop() {
    const maxThinkingLoops = 5;
    const turnLoopState = {
      thinkingLoops: 0,
      turnsAfterCompactPrompt: -1,
      turnsSinceSubagentReminder: 0,
    };

    while (true) {
      // Check if auto-approve was paused by Ctrl-C during tool execution
      if (pauseSignal.isPaused()) {
        pauseSignal.reset();
        break;
      }

      state.turns++;

      // Cache the prefix that survives the switch back to the main agent.
      const switchMessageIndex =
        subagentManager.getActiveSubagent()?.switchMessageIndex;
      const additionalCacheBreakpointIndices =
        switchMessageIndex !== undefined && switchMessageIndex > 0
          ? [switchMessageIndex - 1]
          : undefined;

      const modelOutput = await callModel({
        messages: stateManager.getMessages(),
        tools: toolDefs,
        additionalCacheBreakpointIndices,
        /**
         * @param {PartialMessageContent} partialContent
         */
        onPartialMessageContent: (partialContent) => {
          emitEvent({
            timestamp: new Date(),
            type: "partial_message_content",
            partialContent,
          });
        },
      });

      if (modelOutput instanceof Error) {
        emitEvent({ timestamp: new Date(), type: "error", error: modelOutput });
        break;
      }

      const { message: assistantMessage, providerTokenUsage } = modelOutput;
      stateManager.appendMessages([assistantMessage]);
      if (providerTokenUsage) {
        emitEvent({
          timestamp: new Date(),
          type: "token_usage",
          usage: providerTokenUsage,
        });
      }

      // Gemini may stop with "thinking" -> continue
      const lastContent = assistantMessage.content.at(-1);
      if (lastContent?.type === "thinking") {
        turnLoopState.thinkingLoops += 1;
        if (turnLoopState.thinkingLoops > maxThinkingLoops) {
          break;
        }

        stateManager.appendMessages([
          {
            role: "user",
            content: [{ type: "text", text: "System: Continue" }],
          },
        ]);
        console.error(
          styleText(
            "yellow",
            `\nModel is thinking. Sending "System: Continue" (Loop: ${turnLoopState.thinkingLoops}/${maxThinkingLoops})`,
          ),
        );
        continue;
      }

      const toolUseParts = assistantMessage.content.filter(
        (part) => part.type === "tool_use",
      );

      // No tool use -> turn end
      if (toolUseParts.length === 0) {
        break;
      }

      const validation = toolExecutor.validateBatch(toolUseParts);
      if (!validation.isValid) {
        stateManager.appendMessages([
          {
            role: "user",
            content: validation.toolResults,
          },
        ]);
        continue;
      }

      // Approve tool use
      const decisions = toolUseParts.map(toolUseApprover.isAllowedToolUse);

      const hasDeniedToolUse = decisions.some((d) => d.action === "deny");
      if (hasDeniedToolUse) {
        /** @type {MessageContentToolResult[]} */
        const toolResults = toolUseParts.map((toolUse, index) => {
          const decision = decisions[index];
          const rejectionMessage =
            decision.action === "deny"
              ? `Tool call rejected. ${decision.reason || ""}`.trim()
              : "Tool call rejected due to other denied tool calls";

          return {
            type: "tool_result",
            toolUseId: toolUse.toolUseId,
            toolName: toolUse.toolName,
            content: [{ type: "text", text: rejectionMessage }],
            isError: true,
          };
        });
        stateManager.appendMessages([{ role: "user", content: toolResults }]);
        continue;
      }

      const isAllToolUseApproved = decisions.every((d) => d.action === "allow");
      if (!isAllToolUseApproved) {
        emitEvent({
          timestamp: new Date(),
          type: "tool_use_request",
          toolUseCount: toolUseParts.length,
        });
        break;
      }

      // Ctrl-C during model call: skip execution and ask for approval
      if (pauseSignal.isPaused()) {
        pauseSignal.reset();
        emitEvent({
          timestamp: new Date(),
          type: "tool_use_request",
          toolUseCount: toolUseParts.length,
        });
        break;
      }

      const executionResult = await toolExecutor.executeBatch(toolUseParts);

      if (!executionResult.success) {
        stateManager.appendMessages([
          {
            role: "user",
            content: executionResult.errors,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: executionResult.errorMessage,
              },
            ],
          },
        ]);
        console.error(styleText("yellow", executionResult.errorMessage));
        continue;
      }

      const toolResults = executionResult.results;

      // Switch from subagent to main agent
      let subagentReported = false;
      const result = subagentManager.processToolResults(
        toolUseParts,
        toolResults,
        stateManager.getMessages(),
      );
      if (result.state.type === "replaceMessages") {
        stateManager.replaceMessages(result.state.messages);
        subagentReported = true;
      }
      if (result.newMessage) {
        stateManager.appendMessages([result.newMessage]);
      } else {
        stateManager.appendMessages([{ role: "user", content: toolResults }]);
      }
      if (subagentReported) {
        continue;
      }

      // Auto-compact
      if (
        applyCompactContextIfCalled(stateManager, toolUseParts, toolResults)
      ) {
        continue;
      }

      // Insert compact prompt if input tokens exceed the soft limit
      if (contextSoftLimit && inputTokensKeys && providerTokenUsage) {
        const inputTokens = extractInputTokenCount(
          providerTokenUsage,
          inputTokensKeys,
        );
        if (inputTokens !== undefined && inputTokens > contextSoftLimit) {
          if (
            0 <= turnLoopState.turnsAfterCompactPrompt &&
            turnLoopState.turnsAfterCompactPrompt < 3
          ) {
            turnLoopState.turnsAfterCompactPrompt += 1;
          } else {
            stateManager.appendMessages([
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: buildCompactPrompt({
                      isSubagent: subagentManager.isSubagentActive(),
                    }),
                  },
                ],
              },
            ]);
            turnLoopState.turnsAfterCompactPrompt = 0;
            console.error(
              styleText(
                "yellow",
                `\nContext exceeded soft limit (${inputTokens.toLocaleString()} / ${contextSoftLimit.toLocaleString()} tokens). Auto-compact prompt inserted.`,
              ),
            );
          }
          continue;
        }
        // Input tokens do not exceed soft limit
        turnLoopState.turnsAfterCompactPrompt = -1;
      }

      if (budget) {
        const exceededSoftLimit = budget.softLimits.find((b) => {
          return (
            (b.type === "time" &&
              Date.now() - loopCreatedAt.getTime() > b.seconds * 1000) ||
            (b.type === "turns" && state.turns > b.turns)
          );
        });

        if (exceededSoftLimit) {
          if (
            0 <= state.turnsAfterBudgetSoftLimitPrompt &&
            state.turnsAfterBudgetSoftLimitPrompt < 3
          ) {
            state.turnsAfterBudgetSoftLimitPrompt += 1;
          } else {
            stateManager.appendMessages([
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: budget.promptOnSoftLimitExceeded,
                  },
                ],
              },
            ]);
            state.turnsAfterBudgetSoftLimitPrompt = 0;
            console.error(
              styleText(
                "yellow",
                `\nBudget exceeded soft limit (${JSON.stringify(exceededSoftLimit)}). Prompt inserted.`,
              ),
            );
          }
          continue;
        }
        // Budget soft limit not exceeded
        state.turnsAfterBudgetSoftLimitPrompt = -1;
      }

      // Subagent reminder: every 5 turns, remind the model of its subagent role
      if (subagentManager.isSubagentActive()) {
        turnLoopState.turnsSinceSubagentReminder += 1;
        if (turnLoopState.turnsSinceSubagentReminder % 5 === 0) {
          const activeSubagent = subagentManager.getActiveSubagent();
          stateManager.appendMessages([
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `System: You are subagent "${activeSubagent?.name}". Call "switch_to_main_agent" when your goal is done.`,
                },
              ],
            },
          ]);
        }
      } else {
        // Not in subagent mode
        turnLoopState.turnsSinceSubagentReminder = 0;
      }
    }
  }

  return {
    handleUserInput,
  };
}

/**
 * @typedef {Object} InputHandlerContext
 * @property {StateManager} stateManager
 * @property {ToolExecutor} toolExecutor
 * @property {SubagentManager} subagentManager
 * @property {ToolUseApprover} toolUseApprover
 */

/**
 * @typedef {ReturnType<typeof createInputHandler>} InputHandler
 */

/**
 * Create an input handler.
 *
 * @param {InputHandlerContext} context
 */
export function createInputHandler(context) {
  const { stateManager, toolExecutor, subagentManager, toolUseApprover } =
    context;

  /**
   * Determine input type based on current state and input.
   * @param {UserMessage["content"]} input
   * @returns {'toolApproval' | 'resume' | 'text'}
   */
  function determineInputType(input) {
    const lastMessage = stateManager.getMessageAt(-1);

    // Check if there's a pending tool call
    if (lastMessage?.content.some((part) => part.type === "tool_use")) {
      return "toolApproval";
    }

    if (
      input.length === 1 &&
      input[0].type === "text" &&
      input[0].text.toLowerCase() === "/resume"
    ) {
      return "resume";
    }

    return "text";
  }

  /**
   * Handle tool approval/rejection input.
   * @param {UserMessage["content"]} input
   */
  async function handleToolApproval(input) {
    const lastMessage = stateManager.getMessageAt(-1);
    if (!lastMessage) return;

    /** @type {MessageContentToolUse[]} */
    const toolUseParts = lastMessage.content.filter(
      (part) => part.type === "tool_use",
    );

    const isApproval =
      input.length === 1 &&
      input[0].type === "text" &&
      input[0].text.toLocaleLowerCase().match(/^(yes|y|ｙ)$/i);

    if (isApproval) {
      if (
        /** @type {MessageContentText} */ (input[0]).text.match(/^(YES|Y)$/)
      ) {
        for (const toolUse of toolUseParts) {
          toolUseApprover.allowToolUse(toolUse);
        }
      }

      const executionResult = await toolExecutor.executeBatch(toolUseParts);
      if (!executionResult.success) {
        stateManager.appendMessages([
          { role: "user", content: executionResult.errors },
        ]);
        return;
      }

      const toolResults = executionResult.results;

      if (
        applyCompactContextIfCalled(stateManager, toolUseParts, toolResults)
      ) {
        return;
      }

      const result = subagentManager.processToolResults(
        toolUseParts,
        toolResults,
        stateManager.getMessages(),
      );
      if (result.state.type === "replaceMessages") {
        stateManager.replaceMessages(result.state.messages);
      }

      if (result.newMessage) {
        stateManager.appendMessages([result.newMessage]);
      } else {
        stateManager.appendMessages([{ role: "user", content: toolResults }]);
      }
    } else {
      // Rejected
      /** @type {MessageContentToolResult[]} */
      const toolResults = toolUseParts.map((toolUse) => ({
        type: "tool_result",
        toolUseId: toolUse.toolUseId,
        toolName: toolUse.toolName,
        content: [{ type: "text", text: "Tool call rejected" }],
        isError: true,
      }));

      stateManager.appendMessages([
        { role: "user", content: toolResults },
        {
          role: "user",
          content: input,
        },
      ]);
    }
  }

  async function handleResume() {
    // Resume the conversation stopped by unexpected error, etc.
    // No state changes needed
  }

  /**
   * @param {UserMessage["content"]} input
   */
  async function handleText(input) {
    stateManager.appendMessages([
      {
        role: "user",
        content: input,
      },
    ]);
  }

  return {
    /**
     * @param {UserMessage["content"]} input
     */
    async handle(input) {
      const inputType = determineInputType(input);

      switch (inputType) {
        case "toolApproval":
          await handleToolApproval(input);
          break;
        case "resume":
          await handleResume();
          break;
        case "text":
          await handleText(input);
          break;
      }
    },
  };
}

/**
 * If compact_context was called successfully, discard the prior conversation
 * (keeping only the system prompt) and append the tool result as a standard
 * user message so the model can resume from the reloaded memory file.
 * @param {StateManager} stateManager
 * @param {MessageContentToolUse[]} toolUseParts
 * @param {MessageContentToolResult[]} toolResults
 * @returns {boolean} true if compact was applied
 */
function applyCompactContextIfCalled(stateManager, toolUseParts, toolResults) {
  const compactToolUse = toolUseParts.find(
    (t) => t.toolName === compactContextToolName,
  );
  if (!compactToolUse) return false;

  const compactResult = toolResults.find(
    (r) => r.toolUseId === compactToolUse.toolUseId,
  );
  if (!compactResult || compactResult.isError) return false;

  const systemMessage = stateManager.getMessageAt(0);
  if (!systemMessage) return false;

  stateManager.replaceMessages([systemMessage]);
  stateManager.appendMessages([
    { role: "user", content: compactResult.content },
  ]);
  return true;
}

/**
 * Extract the input (prompt/context) token count from a single turn's
 * provider token usage object by summing the values of the specified keys.
 *
 * Returns `undefined` when no specified key yields a positive number.
 *
 * @param {ProviderTokenUsage} usage
 * @param {string[]} inputTokensKeys - Keys whose numeric values are summed.
 * @returns {number | undefined}
 */
export function extractInputTokenCount(usage, inputTokensKeys) {
  let total = 0;
  let found = false;

  for (const key of inputTokensKeys) {
    const value = usage[key];
    if (typeof value === "number" && value > 0) {
      total += value;
      found = true;
    }
  }

  return found ? total : undefined;
}
