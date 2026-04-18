/**
 * @import { UserEventEmitter, AgentEventEmitter, AgentCommands } from "./agent"
 * @import { ClaudeCodePlugin } from "./claudeCodePlugin.mjs"
 */

import readline from "node:readline";
import { styleText } from "node:util";
import { createCommandHandler } from "./cliCommands.mjs";
import { createCompleter, SLASH_COMMANDS } from "./cliCompleter.mjs";
import {
  formatCostSummary,
  formatProviderTokenUsage,
  printMessage,
} from "./cliFormatter.mjs";
import { createPasteHandler } from "./cliPasteTransform.mjs";
import { notify } from "./utils/notify.mjs";

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

  const handleCtrlC = () => {
    // If agent is running, pause auto-approve instead of exiting
    if (!state.turn) {
      agentCommands.pauseAutoApprove();
      console.log(
        styleText(
          "yellow",
          "\n⚠ Ctrl-C: Auto-approve paused. Finishing current tool...",
        ),
      );
      return;
    }

    const now = Date.now();
    if (now - lastExitAttempt < EXIT_CONFIRM_TIMEOUT) {
      handleExit();
      return;
    }
    lastExitAttempt = now;
    console.log(styleText("yellow", "\nPress Ctrl-C or Ctrl-D again to exit."));
  };

  // Create a transform stream to handle bracketed paste before readline
  const paste = createPasteHandler(handleCtrlC);

  // Set up transformed stdin for readline
  process.stdin.pipe(paste.transform);

  // Enable bracketed paste mode
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004h");
  }

  let currentCliPrompt = getCliPrompt();
  /** @type {import("node:readline").Interface} */
  const cli = readline.createInterface({
    input: paste.transform,
    output: process.stdout,
    prompt: currentCliPrompt,
    completer: createCompleter(() => cli, claudeCodePlugins),
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

  // Handle readline close (e.g., stdin closed externally)
  cli.on("close", handleExit);

  const handleCommand = createCommandHandler({
    agentCommands,
    userEventEmitter,
    claudeCodePlugins,
    helpMessage: HELP_MESSAGE,
  });

  /**
   * Process the complete user input.
   * @param {string} input
   * @returns {Promise<void>}
   */
  async function processInput(input) {
    // Prevent concurrent input processing from multi-line paste
    state.turn = false;

    // Resolve paste placeholders to original content
    const resolvedInput = paste.resolvePlaceholders(input);
    const inputTrimmed = resolvedInput.trim();

    if (inputTrimmed.length === 0) {
      state.turn = true;
      cli.prompt();
      return;
    }

    cli.setPrompt(currentCliPrompt);

    const result = await handleCommand(inputTrimmed);
    if (result === "prompt") {
      state.turn = true;
      cli.prompt();
    }
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
