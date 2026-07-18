/**
 * @import { AgentEventSink } from "./agent"
 * @import { CallModel, MessageContentText, MessageContentImage, MessageContentToolResult, PartialMessageContent, UserMessage, MessageContentToolUse } from "./model"
 * @import { ToolDefinition, ToolUseApprover } from "./tool"
 * @import { SubagentManager } from "./subagent.mjs"
 * @import { StateManager } from "./agentState.mjs"
 */

import { styleText } from "node:util";
import { buildCompactPrompt } from "./prompt.mjs";
import { extractInputTokenCount } from "./tokenUsage.mjs";
import { compactContextToolName } from "./tools/compactContext.mjs";

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

  stateManager.setMessages([systemMessage]);
  stateManager.appendMessages([
    { role: "user", content: compactResult.content },
  ]);
  return true;
}

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
 * @property {import("./toolExecutor.mjs").ToolExecutor} toolExecutor - Tool executor instance
 * @property {AgentEventSink} emitEvent - Sink that pushes agent events onto the output stream
 * @property {ToolUseApprover} toolUseApprover - Tool use approval checker
 * @property {SubagentManager} subagentManager - Subagent manager instance
 * @property {PauseSignal} pauseSignal - Signal to pause auto-approve after current tool completes
 * @property {number} [contextSoftLimit] - Soft limit on input tokens for auto-compact
 * @property {string[]} [inputTokensKeys] - Keys in providerTokenUsage to sum for input token count
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
}) {
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
    emitEvent({ type: "turnEnd" });
  }

  /**
   * Run the main agent turn loop
   * @returns {Promise<void>}
   */
  async function runTurnLoop() {
    let thinkingLoops = 0;
    const maxThinkingLoops = 5;
    let turnsAfterCompactPrompt = -1;
    let turnsSinceSubagentReminder = 0;
    while (true) {
      // Check if auto-approve was paused by Ctrl-C during tool execution
      if (pauseSignal.isPaused()) {
        pauseSignal.reset();
        break;
      }

      const modelOutput = await callModel({
        messages: stateManager.getMessages(),
        tools: toolDefs,
        /**
         * @param {PartialMessageContent} partialContent
         */
        onPartialMessageContent: (partialContent) => {
          emitEvent({ type: "partialMessageContent", partialContent });
        },
      });

      if (modelOutput instanceof Error) {
        emitEvent({ type: "error", error: modelOutput });
        break;
      }

      const { message: assistantMessage, providerTokenUsage } = modelOutput;
      stateManager.appendMessages([assistantMessage]);
      if (providerTokenUsage) {
        emitEvent({ type: "providerTokenUsage", usage: providerTokenUsage });
      }

      // Gemini may stop with "thinking" -> continue
      const lastContent = assistantMessage.content.at(-1);
      if (lastContent?.type === "thinking") {
        thinkingLoops += 1;
        if (thinkingLoops > maxThinkingLoops) {
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
            `\nModel is thinking. Sending "System: Continue" (Loop: ${thinkingLoops}/${maxThinkingLoops})`,
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
          type: "toolUseRequest",
          toolUseCount: toolUseParts.length,
        });
        break;
      }

      // Ctrl-C during model call: skip execution and ask for approval
      if (pauseSignal.isPaused()) {
        pauseSignal.reset();
        emitEvent({
          type: "toolUseRequest",
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

      if (
        applyCompactContextIfCalled(stateManager, toolUseParts, toolResults)
      ) {
        turnsAfterCompactPrompt = -1;
        continue;
      }

      const result = subagentManager.processToolResults(
        toolUseParts,
        toolResults,
        stateManager.getMessages(),
      );
      stateManager.setMessages(result.messages);
      if (result.newMessage) {
        stateManager.appendMessages([result.newMessage]);
      } else {
        stateManager.appendMessages([{ role: "user", content: toolResults }]);
      }

      // Subagent reminder: every 5 turns, remind the model of its subagent role
      let autoCompactFired = false;

      // Auto-compact: insert prompt if context exceeds soft limit
      if (contextSoftLimit && inputTokensKeys && providerTokenUsage) {
        const inputTokens = extractInputTokenCount(
          providerTokenUsage,
          inputTokensKeys,
        );
        if (inputTokens !== undefined && inputTokens > contextSoftLimit) {
          if (0 <= turnsAfterCompactPrompt && turnsAfterCompactPrompt < 3) {
            turnsAfterCompactPrompt += 1;
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
            turnsAfterCompactPrompt = 0;
            autoCompactFired = true;
            console.error(
              styleText(
                "yellow",
                `\nContext exceeded soft limit (${inputTokens.toLocaleString()} / ${contextSoftLimit.toLocaleString()} tokens). Auto-compact prompt inserted.`,
              ),
            );
          }
        }
      }

      if (!subagentManager.isSubagentActive()) {
        turnsSinceSubagentReminder = 0;
      } else if (!autoCompactFired) {
        turnsSinceSubagentReminder += 1;
        // Inject reminder every 5 turns (fires when counter reaches 5, 10, 15, ...)
        if (turnsSinceSubagentReminder % 5 === 0) {
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
 * @property {import("./toolExecutor.mjs").ToolExecutor} toolExecutor
 * @property {import("./subagent.mjs").SubagentManager} subagentManager
 * @property {import("./tool.d.ts").ToolUseApprover} toolUseApprover
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
      stateManager.setMessages(result.messages);

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
