/**
 * @import { UserEventEmitter, AgentCommands } from "./agent"
 * @import { ClaudeCodePlugin } from "./claudeCodePlugin.mjs"
 */

import { execFileSync } from "node:child_process";
import { styleText } from "node:util";
import { formatCostSummary } from "./cliFormatter.mjs";
import { loadAgentRoles } from "./context/loadAgentRoles.mjs";
import { loadPrompts } from "./context/loadPrompts.mjs";
import { loadUserMessageContext } from "./context/loadUserMessageContext.mjs";
import { parseFileRange } from "./utils/parseFileRange.mjs";
import { readFileRange } from "./utils/readFileRange.mjs";

/**
 * @typedef {"prompt" | "continue"} CommandResult
 * - "prompt": return control to prompt (state.turn = true; cli.prompt())
 * - "continue": agent is now running, do nothing
 */

/**
 * @typedef {object} CommandHandlerDeps
 * @property {AgentCommands} agentCommands
 * @property {UserEventEmitter} userEventEmitter
 * @property {ClaudeCodePlugin[] | undefined} claudeCodePlugins
 * @property {string} helpMessage
 */

/**
 * Create command handler function for processing slash commands.
 *
 * @param {CommandHandlerDeps} deps
 * @returns {(input: string) => Promise<CommandResult>}
 */
export function createCommandHandler({
  agentCommands,
  userEventEmitter,
  claudeCodePlugins,
  helpMessage,
}) {
  /**
   * Invoke an agent with the given id and goal.
   * @param {string} id
   * @param {string} goal
   * @returns {Promise<CommandResult>}
   */
  async function invokeAgent(id, goal) {
    const agentRoles = await loadAgentRoles(claudeCodePlugins);
    const agent = agentRoles.get(id);
    const name = agent ? id : `custom:${id}`;

    const [goalTextContent, ...goalImages] = await loadUserMessageContext(goal);
    const goalText =
      goalTextContent?.type === "text" ? goalTextContent.text : goal;

    const messageText = `Delegate to "${name}" agent with goal: ${goalText}`;
    userEventEmitter.emit("userInput", [
      { type: "text", text: messageText },
      ...goalImages,
    ]);
    return "continue";
  }

  /**
   * Invoke a prompt with the given id, args, and display invocation.
   * @param {string} id
   * @param {string} args
   * @param {string} displayInvocation
   * @returns {Promise<CommandResult>}
   */
  async function invokePrompt(id, args, displayInvocation) {
    const prompts = await loadPrompts(claudeCodePlugins);
    const prompt = prompts.get(id);

    if (!prompt) {
      console.log(styleText("red", `\nPrompt not found: ${id}`));
      return "prompt";
    }

    const [argsTextContent, ...argsImages] = args
      ? await loadUserMessageContext(args)
      : [];
    const argsText =
      argsTextContent?.type === "text" ? argsTextContent.text : args;

    const invocation = `${displayInvocation}${argsText ? ` ${argsText}` : ""}`;
    const message = prompt.isSkill
      ? `System: This prompt was invoked as "${invocation}".\nPrompt path: ${prompt.filePath}\n\n${prompt.content}`
      : `System: This prompt was invoked as "${invocation}".\n\n${prompt.content}`;

    userEventEmitter.emit("userInput", [
      { type: "text", text: message },
      ...argsImages,
    ]);
    return "continue";
  }

  /**
   * Handle a complete user input string and return a CommandResult.
   * @param {string} inputTrimmed
   * @returns {Promise<CommandResult>}
   */
  return async function handleCommand(inputTrimmed) {
    // /help or help
    if (["/help", "help"].includes(inputTrimmed.toLowerCase())) {
      console.log(`\n${helpMessage}`);
      return "prompt";
    }

    // !path — read file content and emit as user input
    if (inputTrimmed.startsWith("!")) {
      const fileRange = parseFileRange(inputTrimmed.slice(1));
      if (fileRange instanceof Error) {
        console.log(styleText("red", `\n${fileRange.message}`));
        return "prompt";
      }

      const fileContent = await readFileRange(fileRange);
      if (fileContent instanceof Error) {
        console.log(styleText("red", `\n${fileContent.message}`));
        return "prompt";
      }

      const messageWithContext = await loadUserMessageContext(fileContent);
      userEventEmitter.emit("userInput", messageWithContext);
      return "continue";
    }

    // /dump
    if (inputTrimmed.toLowerCase() === "/dump") {
      await agentCommands.dumpMessages();
      return "prompt";
    }

    // /load
    if (inputTrimmed.toLowerCase() === "/load") {
      await agentCommands.loadMessages();
      return "prompt";
    }

    // /cost
    if (inputTrimmed.toLowerCase() === "/cost") {
      const summary = agentCommands.getCostSummary();
      console.log(formatCostSummary(summary));
      return "prompt";
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
          const line = `  ${styleText("cyan", role.id.padEnd(20))} - ${role.description}`;
          console.log(
            line.length > maxLength ? `${line.slice(0, maxLength)}...` : line,
          );
        }
      }
      return "prompt";
    }

    if (inputTrimmed.startsWith("/agents:")) {
      const match = inputTrimmed.match(/^\/agents:([^ ]+)(?:\s+(.*))?$/s);
      if (!match) {
        console.log(styleText("red", "\nInvalid agent invocation format."));
        return "prompt";
      }
      return await invokeAgent(match[1], match[2] || "");
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
            const line = `  ${styleText("cyan", prompt.id.padEnd(20))} - ${prompt.description}`;
            console.log(
              line.length > maxLength ? `${line.slice(0, maxLength)}...` : line,
            );
          }
        }
        return "prompt";
      }

      if (inputTrimmed.startsWith("/prompts:")) {
        const match = inputTrimmed.match(/^\/prompts:([^ ]+)(?:\s+(.*))?$/s);
        if (!match) {
          console.log(styleText("red", "\nInvalid prompt invocation format."));
          return "prompt";
        }
        return await invokePrompt(
          match[1],
          match[2] || "",
          `/prompts:${match[1]}`,
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
      userEventEmitter.emit("userInput", messageWithContext);
      return "continue";
    }

    // /<id> — shortcut for prompts in shortcuts/ directory
    if (inputTrimmed.startsWith("/")) {
      const match = inputTrimmed.match(/^\/([^ ]+)(?:\s+(.*))?$/);
      if (match) {
        const id = match[1];
        const prompts = await loadPrompts(claudeCodePlugins);
        const prompt = prompts.get(id);

        if (prompt?.isShortcut) {
          return await invokePrompt(id, match[2] || "", `/${id}`);
        }
      }
    }

    // Default: emit as plain user input
    const messageWithContext = await loadUserMessageContext(inputTrimmed);
    userEventEmitter.emit("userInput", messageWithContext);
    return "continue";
  };
}
