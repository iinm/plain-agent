/**
 * @import { Agent, ToolApprovalDecision } from "../agent"
 * @import { CostTracker } from "../metrics/costTracker.mjs";
 * @import { ClaudeCodePlugin } from "../claudeCodePlugin.mjs"
 * @import { MessageContentText, MessageContentImage } from "../model"
 */

import { execFileSync } from "node:child_process";
import { styleText } from "node:util";
import { loadAgentRoles } from "../context/loadAgentRoles.mjs";
import { loadPrompts } from "../context/loadPrompts.mjs";
import { loadUserMessageContext } from "../context/loadUserMessageContext.mjs";
import {
  buildCompactPrompt,
  CLAUDE_CODE_COMPATIBILITY_NOTES,
} from "../prompt.mjs";
import { parseFileRange } from "../utils/parseFileRange.mjs";
import { readFileRange } from "../utils/readFileRange.mjs";
import { toOneLine } from "../utils/toOneLine.mjs";
import { formatCostSummary } from "./formatter.mjs";

/**
 * @typedef {"prompt" | "continue"} CommandResult
 * - "prompt": return control to prompt (state.turn = true; cli.prompt())
 * - "continue": agent is now running, do nothing
 * - "continue": agent is now running, do nothing
 */

/**
 * @typedef {object} CommandHandlerOptions
 * @property {boolean} [awaitingToolApproval] - True while a tool approval is pending
 */

/**
 * @typedef {object} CommandHandlerDeps
 * @property {Agent} agent
 * @property {CostTracker} costTracker
 * @property {ClaudeCodePlugin[] | undefined} claudeCodePlugins
 * @property {string} helpMessage
 */

/** @param {string} input */
export function matchShortcutCommand(input) {
  return input.match(/^\/([^ ]+)(?:\s+(.*))?$/s);
}

/** @param {string} input */
export function matchPromptsCommand(input) {
  return input.match(/^\/prompts:([^ ]+)(?:\s+(.*))?$/s);
}

/** @param {string} input */
export function matchAgentsCommand(input) {
  return input.match(/^\/agents:([^ ]+)(?:\s+(.*))?$/s);
}

/**
 * Interpret raw user input as a tool-approval decision.
 * `Y`/`YES` allow for the session, `y`/`yes`/`ｙ` allow once.
 * @param {string} input
 * @returns {ToolApprovalDecision | null}
 */
export function parseToolApprovalInput(input) {
  if (/^(YES|Y)$/.test(input)) return { action: "allowSession" };
  if (/^(yes|y|ｙ)$/i.test(input)) return { action: "allow" };
  return null;
}

/**
 * Create command handler function for processing slash commands.
 *
 * @param {CommandHandlerDeps} deps
 * @returns {(input: string, options?: CommandHandlerOptions) => Promise<CommandResult>}
 */
export function createCommandHandler({
  agent,
  costTracker,
  claudeCodePlugins,
  helpMessage,
}) {
  /**
   * Send content to the agent. While a tool approval is pending, the content
   * is passed as a denial decision so the model receives it as feedback.
   * @param {(MessageContentText | MessageContentImage)[]} content
   * @param {boolean} awaitingToolApproval
   * @returns {CommandResult}
   */
  function sendToAgent(content, awaitingToolApproval) {
    if (awaitingToolApproval) {
      agent.respondToToolApproval({ action: "deny", content });
    } else {
      agent.send(content);
    }
    return "continue";
  }
  /**
   * Invoke an agent with the given id and goal.
   * @param {string} id
   * @param {string} goal
   * @param {boolean} awaitingToolApproval
   * @returns {Promise<CommandResult>}
   */
  async function invokeAgent(id, goal, awaitingToolApproval) {
    const agentRoles = await loadAgentRoles(claudeCodePlugins);
    const agentRole = agentRoles.get(id);
    const name = agentRole ? id : `custom:${id}`;

    const [goalTextContent, ...goalImages] = await loadUserMessageContext(goal);
    const goalText =
      goalTextContent?.type === "text" ? goalTextContent.text : goal;

    const messageText = `Switch to "${name}" subagent with goal: ${goalText}`;
    return sendToAgent(
      [{ type: "text", text: messageText }, ...goalImages],
      awaitingToolApproval,
    );
  }

  /**
   * Invoke a prompt with the given id, args, and display invocation.
   * @param {string} id
   * @param {string} args
   * @param {string} displayInvocation
   * @param {boolean} awaitingToolApproval
   * @returns {Promise<CommandResult>}
   */
  async function invokePrompt(
    id,
    args,
    displayInvocation,
    awaitingToolApproval,
  ) {
    const prompts = await loadPrompts(claudeCodePlugins);
    const prompt = prompts.get(id);

    if (!prompt) {
      console.error(styleText("red", `\nPrompt not found: ${id}`));
      return "prompt";
    }

    const [argsTextContent, ...argsImages] = args
      ? await loadUserMessageContext(args)
      : [];
    const argsText =
      argsTextContent?.type === "text" ? argsTextContent.text : args;

    const invocation = `${displayInvocation}${argsText ? ` ${argsText}` : ""}`;
    const promptContent = prompt.claudeOriginated
      ? `${prompt.content}\n\n---\n\n${CLAUDE_CODE_COMPATIBILITY_NOTES}`
      : prompt.content;
    const message = prompt.isSkill
      ? `System: This prompt was invoked as "${invocation}".\nPrompt path: ${prompt.filePath}\n\n${promptContent}`
      : `System: This prompt was invoked as "${invocation}".\n\n${promptContent}`;

    return sendToAgent(
      [{ type: "text", text: message }, ...argsImages],
      awaitingToolApproval,
    );
  }

  /**
   * Handle a complete user input string and return a CommandResult.
   * @param {string} inputTrimmed
   * @param {CommandHandlerOptions} [options]
   * @returns {Promise<CommandResult>}
   */
  return async function handleCommand(inputTrimmed, options = {}) {
    const awaitingToolApproval = options.awaitingToolApproval ?? false;

    if (awaitingToolApproval) {
      const decision = parseToolApprovalInput(inputTrimmed);
      if (decision) {
        agent.respondToToolApproval(decision);
        return "continue";
      }
    }

    // /resume — resume without adding new user input
    if (!awaitingToolApproval && inputTrimmed.toLowerCase() === "/resume") {
      agent.resume();
      return "continue";
    }
    // /help or help
    if (["/help", "help"].includes(inputTrimmed.toLowerCase())) {
      console.log(`\n${helpMessage}`);
      return "prompt";
    }

    // !path — read file content and emit as user input
    if (inputTrimmed.startsWith("!")) {
      const fileRange = parseFileRange(inputTrimmed.slice(1));
      if (fileRange instanceof Error) {
        console.error(styleText("red", `\n${fileRange.message}`));
        return "prompt";
      }

      const fileContent = await readFileRange(fileRange);
      if (fileContent instanceof Error) {
        console.error(styleText("red", `\n${fileContent.message}`));
        return "prompt";
      }

      const messageWithContext = await loadUserMessageContext(fileContent);
      return sendToAgent(messageWithContext, awaitingToolApproval);
    }

    // /cost
    if (inputTrimmed.toLowerCase() === "/cost") {
      const summary = costTracker.calculateCost();
      console.log(formatCostSummary(summary));
      return "prompt";
    }

    // /compact [reason]
    if (/^\/compact( |$)/i.test(inputTrimmed)) {
      const message = buildCompactPrompt({
        invocation: inputTrimmed,
        isSubagent: agent.getActiveSubagent() !== null,
      });
      return sendToAgent(
        [{ type: "text", text: message }],
        awaitingToolApproval,
      );
    }

    // /agents or /agents:id
    if (inputTrimmed === "/agents") {
      const agentRoles = await loadAgentRoles(claudeCodePlugins);

      console.log(styleText("bold", "\nAvailable Agent Roles:"));
      if (agentRoles.size === 0) {
        console.log("  No agent roles found.");
      } else {
        for (const role of agentRoles.values()) {
          const maxLength = process.stdout.columns ?? 100;
          const desc = toOneLine(role.description);
          const line = `  ${styleText("cyan", role.id.padEnd(20))} - ${desc}`;
          console.log(
            line.length > maxLength ? `${line.slice(0, maxLength)}...` : line,
          );
        }
      }
      return "prompt";
    }

    if (inputTrimmed.startsWith("/agents:")) {
      const match = matchAgentsCommand(inputTrimmed);
      if (!match) {
        console.error(styleText("red", "\nInvalid agent invocation format."));
        return "prompt";
      }
      return await invokeAgent(match[1], match[2] || "", awaitingToolApproval);
    }

    // /prompts or /prompts:id
    if (inputTrimmed.startsWith("/prompts")) {
      const prompts = await loadPrompts(claudeCodePlugins);

      if (inputTrimmed === "/prompts") {
        console.log(styleText("bold", "\nAvailable Prompts:"));
        if (prompts.size === 0) {
          console.log("  No prompts found.");
        } else {
          for (const prompt of prompts.values()) {
            const maxLength = process.stdout.columns ?? 100;
            const desc = toOneLine(prompt.description);
            const line = `  ${styleText("cyan", prompt.id.padEnd(20))} - ${desc}`;
            console.log(
              line.length > maxLength ? `${line.slice(0, maxLength)}...` : line,
            );
          }
        }
        return "prompt";
      }

      if (inputTrimmed.startsWith("/prompts:")) {
        const match = matchPromptsCommand(inputTrimmed);
        if (!match) {
          console.error(
            styleText("red", "\nInvalid prompt invocation format."),
          );
          return "prompt";
        }
        return await invokePrompt(
          match[1],
          match[2] || "",
          `/prompts:${match[1]}`,
          awaitingToolApproval,
        );
      }
    }

    // /paste — read clipboard and emit as user input
    if (inputTrimmed.startsWith("/paste")) {
      const prompt = inputTrimmed.slice("/paste".length).trim();
      let clipboard;
      try {
        if (process.platform === "darwin") {
          clipboard = execFileSync("pbpaste", { encoding: "utf8" });
        } else if (process.platform === "linux") {
          clipboard = execFileSync("xsel", ["--clipboard", "--output"], {
            encoding: "utf8",
          });
        } else {
          console.log(
            styleText(
              "red",
              `\nUnsupported platform for /paste: ${process.platform}`,
            ),
          );
          return "prompt";
        }
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(
          styleText(
            "red",
            `\nFailed to get clipboard content: ${errorMessage}`,
          ),
        );
        return "prompt";
      }

      const combinedInput = prompt ? `${prompt}\n\n${clipboard}` : clipboard;
      const messageWithContext = await loadUserMessageContext(combinedInput);
      return sendToAgent(messageWithContext, awaitingToolApproval);
    }

    // /<id> — shortcut for prompts in shortcuts/ directory
    if (inputTrimmed.startsWith("/")) {
      const match = matchShortcutCommand(inputTrimmed);
      if (match) {
        const id = match[1];
        const prompts = await loadPrompts(claudeCodePlugins);
        const prompt = prompts.get(id);

        if (prompt?.isShortcut) {
          return await invokePrompt(
            id,
            match[2] || "",
            `/${id}`,
            awaitingToolApproval,
          );
        }
      }
    }

    // Default: emit as plain user input
    const messageWithContext = await loadUserMessageContext(inputTrimmed);
    return sendToAgent(messageWithContext, awaitingToolApproval);
  };
}
