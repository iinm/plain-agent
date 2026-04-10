/**
 * @import { Message } from "./model"
 * @import { UserEventEmitter, AgentEventEmitter, AgentCommands } from "./agent"
 * @import { ClaudeCodePlugin } from "./claudeCodePlugin.mjs"
 */

import { execFileSync } from "node:child_process";
import readline from "node:readline";
import { Transform } from "node:stream";
import { styleText } from "node:util";
import {
  formatCostSummary,
  formatProviderTokenUsage,
  formatToolResult,
  formatToolUse,
} from "./cliFormatter.mjs";
import { consumeInterruptMessage } from "./context/consumeInterruptMessage.mjs";
import { loadAgentRoles } from "./context/loadAgentRoles.mjs";
import { loadPrompts } from "./context/loadPrompts.mjs";
import { loadUserMessageContext } from "./context/loadUserMessageContext.mjs";
import { notify } from "./utils/notify.mjs";
import { parseFileRange } from "./utils/parseFileRange.mjs";
import { readFileRange } from "./utils/readFileRange.mjs";

// Define available slash commands for tab completion
const SLASH_COMMANDS = [
  { name: "/help", description: "Display this help message" },
  { name: "/agents", description: "List available agent roles" },
  {
    name: "/agents:<id>",
    description:
      "Delegate to an agent with the given ID (e.g., /agents:code-simplifier)",
  },
  { name: "/prompts", description: "List available prompts" },
  {
    name: "/prompts:<id>",
    description:
      "Invoke a prompt with the given ID (e.g., /prompts:feature-dev)",
  },
  {
    name: "/<id>",
    description:
      "Shortcut for prompts in the shortcuts/ directory (e.g., /commit)",
  },
  { name: "/paste", description: "Paste content from clipboard" },
  {
    name: "/resume",
    description: "Resume conversation after an LLM provider error",
  },
  { name: "/dump", description: "Save current messages to a JSON file" },
  { name: "/load", description: "Load messages from a JSON file" },
  { name: "/cost", description: "Display session cost and token usage" },
];

/**
 * @typedef {Object} CompletionCandidate
 * @property {string} name
 * @property {string} description
 */

/**
 * Find candidates that match the line, prioritizing prefix matches.
 * @param {(string | CompletionCandidate)[]} candidates
 * @param {string} line
 * @param {number} queryStartIndex
 * @returns {(string | CompletionCandidate)[]}
 */
function findMatches(candidates, line, queryStartIndex) {
  const query = line.slice(queryStartIndex);
  const prefixMatches = [];
  const partialMatches = [];

  for (const candidate of candidates) {
    const name = typeof candidate === "string" ? candidate : candidate.name;
    if (name.startsWith(line)) {
      prefixMatches.push(candidate);
    } else if (
      query.length > 0 &&
      name.slice(queryStartIndex).includes(query)
    ) {
      partialMatches.push(candidate);
    }
  }

  return [...prefixMatches, ...partialMatches];
}

/**
 * Return the longest common prefix of the given strings.
 * @param {string[]} strings
 * @returns {string}
 */
function commonPrefix(strings) {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

/**
 * Display completion candidates and invoke the readline callback.
 *
 * Node.js readline normally requires two consecutive Tab presses to show the
 * candidate list. This helper lets readline handle the common-prefix
 * auto-completion first, then prints the candidate list on the next tick and
 * redraws the prompt so the display stays clean.
 *
 * @param {import("node:readline").Interface} rl
 * @param {(string | CompletionCandidate)[]} candidates
 * @param {string} line
 * @param {(err: Error | null, result: [string[], string]) => void} callback
 */
function showCompletions(rl, candidates, line, callback) {
  const names = candidates.map((c) => (typeof c === "string" ? c : c.name));
  if (candidates.length <= 1) {
    callback(null, [names, line]);
    return;
  }
  const prefix = commonPrefix(names);
  if (prefix.length > line.length) {
    // Let readline insert the common prefix.
    callback(null, [[prefix], line]);
  } else {
    // Nothing new to insert.
    callback(null, [[], line]);
  }
  // After readline finishes its own refresh, print the candidate list and
  // redraw the prompt line.  We cannot use rl.prompt(true) because its
  // internal _refreshLine clears everything below the prompt start, which
  // erases the candidate list we just wrote.  Instead we manually re-output
  // the prompt and current line content.
  setTimeout(() => {
    const maxLength = process.stdout.columns ?? 100;
    const list = candidates
      .map((c) => {
        if (typeof c === "string") return c;
        const nameText = c.name.padEnd(25);
        const separator = " - ";
        const descText = c.description;

        // 画面幅に合わせて説明文をカット（色を付ける前に計算）
        const availableWidth =
          maxLength - nameText.length - separator.length - 3;
        const displayDesc =
          descText.length > availableWidth && availableWidth > 0
            ? `${descText.slice(0, availableWidth)}...`
            : descText;

        const name = styleText("cyan", nameText);
        const description = styleText("dim", displayDesc);
        return `${name}${separator}${description}`;
      })
      .join("\r\n");
    process.stdout.write(`\r\n${list}\r\n`);
    process.stdout.write(`${rl.getPrompt()}${rl.line}`);
  }, 0);
}

const HELP_MESSAGE = [
  "Commands:",
  ...SLASH_COMMANDS.map(
    (cmd) => `  ${cmd.name.padEnd(13)} - ${cmd.description}`,
  ),
  "",
  "Multi-line Input Syntax:",
  '  """               - Start/stop multi-line input mode',
  "",
  "File Input Syntax:",
  "  !path/to/file     - Read content from a file",
  "  !path/to/file:N   - Read line N from a file",
  "  !path/to/file:N-M - Read lines N to M from a file",
  "",
  "References (use within input content):",
  "  @path/to/file     - Reference content from another file",
  "  @path/to/file:N   - Reference line N from another file",
  "  @path/to/file:N-M - Reference lines N to M from another file",
  "",
  "Image Attachments (use within input content):",
  "  @path/to/image.png      - Attach an image (png, jpg, jpeg, gif, webp)",
  "  @'path/with spaces.png' - Quote paths that include spaces",
  "  @path/with\\ spaces.png  - Escape spaces with a backslash",
]
  .join("\n")
  .trim()
  .replace(/^[^ ].*:/gm, (m) => styleText("bold", m))
  .replace(/^ {2}\/.+?(?= - )/gm, (m) => styleText("cyan", m))
  .replace(/^ {2}.+?(?= - )/gm, (m) => styleText("blue", m));

// Bracketed paste mode sequences
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

// Store for pasted content
const pastedContentStore = new Map();

/**
 * Generate a short hash for paste reference
 * @param {string} content
 * @returns {string}
 */
function generatePasteHash(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(6, "0").slice(0, 6);
}

/**
 * Resolve paste placeholders and append context tags
 * @param {string} input
 * @returns {string}
 */
function resolvePastePlaceholders(input) {
  /** @type {string[]} */
  const contexts = [];

  // Collect paste content for context tags while keeping placeholders
  const text = input.replace(/\[pasted#([a-f0-9]{6})\]/g, (match, hash) => {
    const content = pastedContentStore.get(hash);
    if (content !== undefined) {
      pastedContentStore.delete(hash); // Clean up after use
      contexts.push(
        `<context location="pasted#${hash}">\n${content}\n</context>`,
      );
    }
    return match; // Keep placeholder in text
  });

  // Append contexts to the end of input
  if (contexts.length > 0) {
    return [text, ...contexts].join("\n\n");
  }

  return text;
}

/**
 * @typedef {object} CliOptions
 * @property {UserEventEmitter} userEventEmitter
 * @property {AgentEventEmitter} agentEventEmitter
 * @property {AgentCommands} agentCommands
 * @property {string} sessionId
 * @property {string} modelName
 * @property {string} notifyCmd
 * @property {boolean} sandbox
 * @property {() => Promise<void>} onStop
 * @property {ClaudeCodePlugin[]} [claudeCodePlugins]
 */

/**
 * @param {CliOptions} options
 */
export function startInteractiveSession({
  userEventEmitter,
  agentEventEmitter,
  agentCommands,
  sessionId,
  modelName,
  notifyCmd,
  sandbox,
  onStop,
  claudeCodePlugins,
}) {
  /** @type {{ turn: boolean, multiLineBuffer: string[] | null, subagentName: string }} */
  const state = {
    turn: true,
    multiLineBuffer: null,
    subagentName: "",
  };

  /**
   * @param {string} id
   * @param {string} goal
   * @returns {Promise<void>}
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
  }

  /**
   * @param {string} id
   * @param {string} args
   * @param {string} displayInvocation
   * @returns {Promise<void>}
   */
  async function invokePrompt(id, args, displayInvocation) {
    const prompts = await loadPrompts(claudeCodePlugins);
    const prompt = prompts.get(id);

    if (!prompt) {
      console.log(styleText("red", `\nPrompt not found: ${id}`));
      state.turn = true;
      cli.prompt();
      return;
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
  }

  const getCliPrompt = (subagentName = "") =>
    [
      "",
      styleText(
        ["white", "bgGray"],
        [
          ...(subagentName ? [`[${subagentName}]`] : []),
          `session: ${sessionId} | model: ${modelName} | sandbox: ${sandbox ? "on" : "off"}`,
        ].join(" "),
      ),
      "> ",
    ].join("\n");

  // Indirect reference for exit handler (assigned after confirmExit is defined)
  let onExitRequest = () => {};

  // Create a transform stream to handle bracketed paste before readline
  let inPasteMode = false;
  let pasteBuffer = "";

  const pasteTransform = new Transform({
    transform(chunk, _encoding, callback) {
      let data = chunk.toString("utf8");

      // Handle Ctrl-C and Ctrl-D
      if (data.includes("\x03") || data.includes("\x04")) {
        // Ctrl-C / Ctrl-D: request exit (handled by confirmExit)
        onExitRequest();
        callback();
        return;
      }

      while (data.length > 0) {
        if (inPasteMode) {
          const endIdx = data.indexOf(BRACKETED_PASTE_END);
          if (endIdx !== -1) {
            // End of paste
            pasteBuffer += data.slice(0, endIdx);
            data = data.slice(endIdx + BRACKETED_PASTE_END.length);
            inPasteMode = false;

            // Handle paste content
            if (pasteBuffer) {
              // Remove trailing newline for single-line paste detection
              const trimmedPaste = pasteBuffer.replace(/\n$/, "");

              // For single-line paste, insert directly without placeholder
              if (!trimmedPaste.includes("\n")) {
                this.push(trimmedPaste);
              } else {
                // For multi-line paste, use placeholder
                const hash = generatePasteHash(pasteBuffer);
                pastedContentStore.set(hash, pasteBuffer);
                this.push(`[pasted#${hash}] `);
              }
            }
            pasteBuffer = "";
          } else {
            // Still in paste mode
            pasteBuffer += data;
            data = "";
          }
        } else {
          const startIdx = data.indexOf(BRACKETED_PASTE_START);
          if (startIdx !== -1) {
            // Start of paste
            // Output any data before the paste
            if (startIdx > 0) {
              this.push(data.slice(0, startIdx));
            }
            data = data.slice(startIdx + BRACKETED_PASTE_START.length);
            inPasteMode = true;
            pasteBuffer = "";
          } else {
            // Normal data
            this.push(data);
            data = "";
          }
        }
      }

      callback();
    },
  });

  // Set up transformed stdin for readline
  process.stdin.pipe(pasteTransform);

  // Enable bracketed paste mode
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004h");
  }

  let currentCliPrompt = getCliPrompt();
  const cli = readline.createInterface({
    input: pasteTransform,
    output: process.stdout,
    prompt: currentCliPrompt,
    /**
     * @param {string} line
     * @param {(err?: Error | null, result?: [string[], string]) => void} callback
     */
    completer: (line, callback) => {
      (async () => {
        try {
          const prompts = await loadPrompts(claudeCodePlugins);
          const agentRoles = await loadAgentRoles(claudeCodePlugins);

          if (line.startsWith("/agents:")) {
            const prefix = "/agents:";
            const candidates = Array.from(agentRoles.values()).map((a) => ({
              name: `${prefix}${a.id}`,
              description: a.description,
            }));
            const hits = findMatches(candidates, line, prefix.length);

            showCompletions(cli, hits, line, callback);
            return;
          }

          if (line.startsWith("/prompts:")) {
            const prefix = "/prompts:";
            const candidates = Array.from(prompts.values()).map((p) => ({
              name: `${prefix}${p.id}`,
              description: p.description,
            }));
            const hits = findMatches(candidates, line, prefix.length);

            showCompletions(cli, hits, line, callback);
            return;
          }

          if (line.startsWith("/")) {
            const shortcuts = Array.from(prompts.values())
              .filter((p) => p.isShortcut)
              .map((p) => ({
                name: `/${p.id}`,
                description: p.description,
              }));

            const allCommands = [...SLASH_COMMANDS, ...shortcuts].filter(
              (cmd) => {
                const name = typeof cmd === "string" ? cmd : cmd.name;
                return (
                  name !== "/<id>" &&
                  (name === "/agents:" || !name.startsWith("/agent:")) &&
                  (name === "/prompts:" || !name.startsWith("/prompt:"))
                );
              },
            );

            const hits = findMatches(allCommands, line, 1);

            showCompletions(cli, hits, line, callback);
            return;
          }

          callback(null, [[], line]);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          callback(error, [[], line]);
        }
      })();
    },
  });

  // Disable automatic prompt redraw on resize during agent turn
  // @ts-expect-error - internal property
  const originalRefreshLine = cli._refreshLine?.bind(cli);
  if (originalRefreshLine) {
    // @ts-expect-error - internal property
    cli._refreshLine = (...args) => {
      if (state.turn) {
        originalRefreshLine(...args);
      }
    };
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  // Cleanup handler to disable bracketed paste mode on exit
  const cleanup = () => {
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[?2004l");
    }
  };

  // Handle exit signals
  let isExiting = false;
  const handleExit = async () => {
    if (isExiting) return;
    isExiting = true;

    cleanup();
    const summary = agentCommands.getCostSummary();
    console.log();
    console.log(formatCostSummary(summary));
    await onStop();
    process.exit(0);
  };

  // Double-press exit confirmation
  let lastExitAttempt = 0;
  const EXIT_CONFIRM_TIMEOUT = 1500;

  const confirmExit = () => {
    const now = Date.now();
    if (now - lastExitAttempt < EXIT_CONFIRM_TIMEOUT) {
      handleExit();
      return;
    }
    lastExitAttempt = now;
    console.log(styleText("yellow", "\nPress Ctrl-C or Ctrl-D again to exit."));
  };

  // Wire up exit request handler for Ctrl-C / Ctrl-D
  onExitRequest = confirmExit;

  // Handle readline close (e.g., stdin closed externally)
  cli.on("close", handleExit);

  /**
   * Process the complete user input.
   * @param {string} input
   * @returns {Promise<void>}
   */
  async function processInput(input) {
    // Prevent concurrent input processing from multi-line paste
    state.turn = false;

    // Resolve paste placeholders to original content
    const resolvedInput = resolvePastePlaceholders(input);
    const inputTrimmed = resolvedInput.trim();

    if (inputTrimmed.length === 0) {
      state.turn = true;
      cli.prompt();
      return;
    }

    cli.setPrompt(currentCliPrompt);
    await consumeInterruptMessage();

    if (["/help", "help"].includes(inputTrimmed.toLowerCase())) {
      console.log(`\n${HELP_MESSAGE}`);
      state.turn = true;
      cli.prompt();
      return;
    }

    if (inputTrimmed.startsWith("!")) {
      const fileRange = parseFileRange(inputTrimmed.slice(1));
      if (fileRange instanceof Error) {
        console.log(styleText("red", `\n${fileRange.message}`));
        state.turn = true;
        cli.prompt();
        return;
      }

      const fileContent = await readFileRange(fileRange);
      if (fileContent instanceof Error) {
        console.log(styleText("red", `\n${fileContent.message}`));
        state.turn = true;
        cli.prompt();
        return;
      }

      const messageWithContext = await loadUserMessageContext(fileContent);

      userEventEmitter.emit("userInput", messageWithContext);
      return;
    }

    if (inputTrimmed.toLowerCase() === "/dump") {
      await agentCommands.dumpMessages();
      state.turn = true;
      cli.prompt();
      return;
    }

    if (inputTrimmed.toLowerCase() === "/load") {
      await agentCommands.loadMessages();
      state.turn = true;
      cli.prompt();
      return;
    }

    if (inputTrimmed.toLowerCase() === "/cost") {
      const summary = agentCommands.getCostSummary();
      console.log(formatCostSummary(summary));
      state.turn = true;
      cli.prompt();
      return;
    }

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
      state.turn = true;
      cli.prompt();
      return;
    }

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
        state.turn = true;
        cli.prompt();
        return;
      }

      if (inputTrimmed.startsWith("/prompts:")) {
        const match = inputTrimmed.match(/^\/prompts:([^ ]+)(?:\s+(.*))?$/s);
        if (!match) {
          console.log(styleText("red", "\nInvalid prompt invocation format."));
          state.turn = true;
          cli.prompt();
          return;
        }
        await invokePrompt(match[1], match[2] || "", `/prompts:${match[1]}`);
        return;
      }
    }

    if (inputTrimmed.startsWith("/agents:")) {
      const match = inputTrimmed.match(/^\/agents:([^ ]+)(?:\s+(.*))?$/s);
      if (!match) {
        console.log(styleText("red", "\nInvalid agent invocation format."));
        state.turn = true;
        cli.prompt();
        return;
      }
      await invokeAgent(match[1], match[2] || "");
      return;
    }

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
          state.turn = true;
          cli.prompt();
          return;
        }
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log(
          styleText(
            "red",
            `\nFailed to get clipboard content: ${errorMessage}`,
          ),
        );
        state.turn = true;
        cli.prompt();
        return;
      }

      const combinedInput = prompt ? `${prompt}\n\n${clipboard}` : clipboard;

      const messageWithContext = await loadUserMessageContext(combinedInput);
      userEventEmitter.emit("userInput", messageWithContext);
      return;
    }

    // Handle shortcuts for prompts in shortcuts/ directory
    if (inputTrimmed.startsWith("/")) {
      const match = inputTrimmed.match(/^\/([^ ]+)(?:\s+(.*))?$/);
      if (match) {
        const id = match[1];
        const prompts = await loadPrompts(claudeCodePlugins);
        const prompt = prompts.get(id);

        if (prompt?.isShortcut) {
          await invokePrompt(id, match[2] || "", `/${id}`);
          return;
        }
      }
    }

    const messageWithContext = await loadUserMessageContext(inputTrimmed);
    userEventEmitter.emit("userInput", messageWithContext);
  }

  cli.on("line", async (lineInput) => {
    if (!state.turn) {
      console.warn(
        styleText(
          "yellow",
          `\nAgent is working. Ignore input: ${lineInput.trim()}`,
        ),
      );
      return;
    }

    // Check for multi-line delimiter
    if (lineInput.trim() === '"""') {
      if (state.multiLineBuffer === null) {
        state.multiLineBuffer = [];
        cli.setPrompt(styleText("gray", "... "));
        cli.prompt();
        return;
      }

      const combined = state.multiLineBuffer.join("\n");
      state.multiLineBuffer = null;
      cli.setPrompt(currentCliPrompt);

      await processInput(combined);
      return;
    }

    // Accumulate lines if in multi-line mode
    if (state.multiLineBuffer !== null) {
      state.multiLineBuffer.push(lineInput);
      cli.prompt();
      return;
    }

    await processInput(lineInput);
  });

  agentEventEmitter.on("partialMessageContent", (partialContent) => {
    if (partialContent.position === "start") {
      const subagentPrefix = state.subagentName
        ? styleText("cyan", `[${state.subagentName}]\n`)
        : "";
      const partialContentStr = styleText("gray", `<${partialContent.type}>`);
      console.log(`\n${subagentPrefix}${partialContentStr}`);
    }
    if (partialContent.content) {
      if (partialContent.type === "tool_use") {
        process.stdout.write(styleText("gray", partialContent.content));
      } else {
        process.stdout.write(partialContent.content);
      }
    }
    if (partialContent.position === "stop") {
      console.log(styleText("gray", `\n</${partialContent.type}>`));
    }
  });

  agentEventEmitter.on("message", (message) => {
    printMessage(message);
  });

  agentEventEmitter.on("toolUseRequest", () => {
    cli.setPrompt(
      [
        styleText(
          "yellow",
          "\nApprove tool calls? (y = allow once, Y = allow in this session, or feedback)",
        ),
        currentCliPrompt,
      ].join("\n"),
    );
  });

  agentEventEmitter.on("subagentSwitched", (subagent) => {
    state.subagentName = subagent?.name ?? "";
    currentCliPrompt = getCliPrompt(state.subagentName);
    cli.setPrompt(currentCliPrompt);
  });

  agentEventEmitter.on("providerTokenUsage", (usage) => {
    console.log(formatProviderTokenUsage(usage));
  });

  agentEventEmitter.on("error", (error) => {
    console.log(
      styleText(
        "red",
        `\nError: message=${error.message}, stack=${error.stack}`,
      ),
    );
  });

  agentEventEmitter.on("turnEnd", async () => {
    const err = notify(notifyCmd);
    if (err) {
      console.error(
        styleText("yellow", `\nNotification error: ${err.message}`),
      );
    }
    // 暫定対応: token usageのconsole出力を確実にflushするため、次のevent loop tickまで遅延
    await new Promise((resolve) => setTimeout(resolve, 0));

    state.turn = true;
    cli.prompt();
  });

  cli.prompt();

  // Register cleanup handlers
  process.on("exit", cleanup);
  process.on("SIGTERM", cleanup);
}

/**
 * @param {Message} message
 */
function printMessage(message) {
  switch (message.role) {
    case "assistant": {
      // console.log(styleText("bold", "\nAgent:"));
      for (const part of message.content) {
        switch (part.type) {
          // Note: Streamで表示するためここでは表示しない
          // case "thinking":
          //   console.log(
          //     [
          //       styleText("blue", "<thinking>"),
          //       part.thinking,
          //       styleText("blue", "</thinking>\n"),
          //     ].join("\n"),
          //   );
          //   break;
          // case "text":
          //   console.log(part.text);
          //   break;
          case "tool_use":
            console.log(styleText("bold", "\nTool call:"));
            console.log(formatToolUse(part));
            break;
        }
      }
      break;
    }
    case "user": {
      for (const part of message.content) {
        switch (part.type) {
          case "tool_result": {
            console.log(styleText("bold", "\nTool result:"));
            console.log(formatToolResult(part));
            break;
          }
          case "text": {
            console.log(styleText("bold", "\nUser:"));
            console.log(part.text);
            break;
          }
          case "image": {
            break;
          }
          default: {
            console.log(styleText("bold", "\nUnknown Message Format:"));
            console.log(JSON.stringify(part, null, 2));
          }
        }
      }
      break;
    }
    default: {
      console.log(styleText("bold", "\nUnknown Message Format:"));
      console.log(JSON.stringify(message, null, 2));
    }
  }
}
