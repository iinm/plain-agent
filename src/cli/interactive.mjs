/**
 * @import { Interface } from "node:readline"
 * @import { Agent } from "../agent"
 * @import { CostTracker } from "../metrics/costTracker.mjs";
 * @import { ClaudeCodePlugin } from "../claudeCodePlugin.mjs"
 * @import { Tool, SandboxModeProvider } from "../tool"
 * @import { PartialMessageContent } from "../model"
 */

import readline from "node:readline";
import { styleText } from "node:util";
import { appendUsageRecord, buildUsageRecord } from "../metrics/usageStore.mjs";
import { persistSessionEvent, sessionFileExists } from "../sessionStore.mjs";
import { notify } from "../utils/notify.mjs";
import { createCommandHandler } from "./commands.mjs";
import { createCompleter, SLASH_COMMANDS } from "./completer.mjs";
import {
  formatCostSummary,
  formatProviderTokenUsage,
  printMessage,
} from "./formatter.mjs";
import { createInterruptTransform } from "./interruptTransform.mjs";
import { createPasteHandler } from "./pasteTransform.mjs";
import { createStreamFormatter } from "./streamFormatter.mjs";

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
 * @property {Agent} agent
 * @property {string} sessionId
 * @property {string} modelName
 * @property {Date} startTime
 * @property {boolean} sandbox
 * @property {{ command: string; args?: string[] } | undefined} notifyCmd
 * @property {CostTracker} costTracker
 * @property {() => Promise<void>} onStop
 * @property {ClaudeCodePlugin[]} [claudeCodePlugins]
 * @property {Tool & SandboxModeProvider} [execCommandTool]
 */

/**
 * @param {CliOptions} options
 */
export function startInteractiveSession({
  agent,
  sessionId,
  modelName,
  startTime,
  notifyCmd,
  sandbox,
  costTracker,
  onStop,
  claudeCodePlugins,
  execCommandTool,
}) {
  const state = {
    turn: true,
    /** @type {string[] | null} */
    multiLineBuffer: null,
    subagentName: agent.getActiveSubagent()?.name ?? "",
    spinnerIndex: 0,
    spinnerLastTime: 0,
    isExiting: false,

    /** Double-press Ctrl-D exit confirmation */
    lastCtrlDAttempt: new Date(0).getTime(),
  };

  const handleExit = async () => {
    if (state.isExiting) return;
    state.isExiting = true;

    const summary = costTracker.calculateCost();
    const hasSessionFile = await sessionFileExists(sessionId);
    if (hasSessionFile) {
      await persistSessionEvent(sessionId, {
        timestamp: new Date(),
        type: "session_end",
        cost: summary,
      });
    }

    const record = buildUsageRecord({
      sessionId,
      mode: "interactive",
      modelName,
      workingDir: process.cwd(),
      costSummary: summary,
      now: startTime,
    });
    if (record) {
      const err = await appendUsageRecord(record);
      if (err) {
        console.error(
          styleText(
            "yellow",
            `Warning: failed to record usage: ${err.message}`,
          ),
        );
      }
    }

    console.log(
      [
        "",
        formatCostSummary(summary),
        ...(hasSessionFile ? ["", `Session saved: ${sessionId}`] : []),
      ].join("\n"),
    );
    await onStop();
    process.exit(0);
  };

  process.on("SIGTERM", handleExit);
  process.on("SIGHUP", handleExit);

  const getCliPrompt = (subagentName = "", flashMessage = "") =>
    [
      "",
      styleText(
        ["white", "bgGray"],
        [
          ...(subagentName ? [`[${subagentName}]`] : []),
          `session: ${sessionId} | model: ${modelName} | sandbox: ${sandbox ? "on" : "off"}`,
        ].join(" "),
      ),
      ...(flashMessage ? [flashMessage] : []),
      "> ",
    ].join("\n");

  /** @type {Interface} */
  let cli;

  /**
   * Clear the current readline input line and redraw the prompt.
   * Also aborts multi-line input mode if active.
   */
  const resetInput = () => {
    if (state.multiLineBuffer !== null) {
      state.multiLineBuffer = null;
      cli.setPrompt(currentCliPrompt);
    }
    cli.write(null, { ctrl: true, name: "a" }); // move to line start
    cli.write(null, { ctrl: true, name: "k" }); // delete to line end
    cli.prompt();
  };

  const handleCtrlC = () => {
    // Agent turn: pause auto-approve; do not clear input.
    if (!state.turn) {
      agent.pauseAutoApprove();
      console.error(
        styleText(
          "yellow",
          "\n\n⚠️ Ctrl-C: Auto-approve paused.\nPress Ctrl-D twice to exit.\n",
        ),
      );
      return;
    }

    // User turn: clear current input. On empty input, show exit hint.
    const hasInput = cli.line.length > 0 || state.multiLineBuffer !== null;
    if (hasInput) {
      resetInput();
    } else {
      cli.setPrompt(
        getCliPrompt(
          state.subagentName,
          styleText("yellow", "Press Ctrl-D twice to exit"),
        ),
      );
      cli.prompt();
    }
    // Reset Ctrl-D confirmation when Ctrl-C is pressed
    state.lastCtrlDAttempt = 0;
  };

  const handleCtrlD = () => {
    // User turn with non-empty input: ignore Ctrl-D entirely.
    if (state.turn && (cli.line.length > 0 || state.multiLineBuffer !== null)) {
      return;
    }

    const now = Date.now();
    if (now - state.lastCtrlDAttempt < 1500) {
      handleExit();
      return;
    }
    state.lastCtrlDAttempt = now;
    if (state.turn) {
      cli.setPrompt(
        getCliPrompt(
          state.subagentName,
          styleText("yellow", "Press Ctrl-D again to exit."),
        ),
      );
      cli.prompt();
    } else {
      console.error(styleText("yellow", "\n\n⚠️ Press Ctrl-D again to exit.\n"));
    }
  };

  // Setup stdin
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // Pre-readline pipeline:
  //   stdin -> interrupt (Ctrl-C / Ctrl-D) -> paste (bracketed paste) -> readline
  const interrupt = createInterruptTransform({
    onCtrlC: handleCtrlC,
    onCtrlD: handleCtrlD,
  });
  const paste = createPasteHandler();
  process.stdin.pipe(interrupt).pipe(paste.transform);

  // Enable bracketed paste mode
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?2004h");
    const disableBracketedPasteMode = () => {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[?2004l");
      }
    };
    process.on("exit", disableBracketedPasteMode);
    process.on("SIGTERM", disableBracketedPasteMode);
    process.on("SIGHUP", disableBracketedPasteMode);
  }

  let currentCliPrompt = getCliPrompt(state.subagentName);
  cli = readline.createInterface({
    input: paste.transform,
    output: process.stdout,
    prompt: currentCliPrompt,
    completer: createCompleter(() => cli, claudeCodePlugins),
  });
  cli.on("close", handleExit);

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

  const handleCommand = createCommandHandler({
    agent,
    costTracker,
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
      console.error(
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

  const outputStreamBuffer = createStreamBuffer();
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinnerIntervalMs = 80;

  /**
   * Render a streaming partial message content chunk.
   * @param {PartialMessageContent} partialContent
   */
  const handlePartialMessageContent = (partialContent) => {
    if (partialContent.position === "start") {
      const subagentPrefix = state.subagentName
        ? styleText("cyan", `[${state.subagentName}]\n`)
        : "";
      const partialContentStr = styleText("gray", `<${partialContent.type}>`);

      if (["thinking", "tool_use"].includes(partialContent.type)) {
        state.spinnerIndex = 0;
        state.spinnerLastTime = Date.now();
        process.stdout.write(
          `\n${subagentPrefix}${partialContentStr} ${styleText("cyan", spinnerFrames[0])}`,
        );
      } else {
        console.log(`\n${subagentPrefix}${partialContentStr}`);
      }
    }
    if (partialContent.content) {
      if (["thinking", "tool_use"].includes(partialContent.type)) {
        const now = Date.now();
        if (now - state.spinnerLastTime >= spinnerIntervalMs) {
          state.spinnerIndex = (state.spinnerIndex + 1) % spinnerFrames.length;
          state.spinnerLastTime = now;
          process.stdout.write(
            `\r\x1b[K${styleText("gray", `<${partialContent.type}>`)} ${styleText("cyan", spinnerFrames[state.spinnerIndex])}`,
          );
        }
      } else if (partialContent.type === "text") {
        outputStreamBuffer.feed(partialContent.content);
      } else {
        process.stdout.write(partialContent.content);
      }
    }
    if (partialContent.position === "stop") {
      if (["thinking", "tool_use"].includes(partialContent.type)) {
        // Clear current line, move up one line, and clear that line too
        process.stdout.write("\x1b[2K\x1b[1F\x1b[2K");
      } else {
        outputStreamBuffer.forceFlush();
        console.log(styleText("gray", `\n</${partialContent.type}>`));
      }
    }
  };

  const consumeAgentEvents = async () => {
    for await (const event of agent.start()) {
      await persistSessionEvent(sessionId, event);
      switch (event.type) {
        case "partial_message_content":
          handlePartialMessageContent(event.partialContent);
          break;

        case "message":
          try {
            await printMessage(event.message, { execCommandTool });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              styleText("red", `Error rendering message: ${message}`),
            );
          }
          break;

        case "tool_use_request": {
          const toolText =
            event.toolUseCount === 1 ? "tool call" : "tool calls";
          cli.setPrompt(
            getCliPrompt(
              state.subagentName,
              styleText(
                "yellow",
                `Approve ${event.toolUseCount} ${toolText}? (y = allow once, Y = allow in this session, or feedback)`,
              ),
            ),
          );
          break;
        }

        case "subagent_switched":
          state.subagentName = event.subagent?.name ?? "";
          currentCliPrompt = getCliPrompt(state.subagentName);
          cli.setPrompt(currentCliPrompt);
          break;

        case "token_usage":
          console.log(formatProviderTokenUsage(event.usage));
          break;

        case "error":
          console.error(
            styleText(
              "red",
              `\nError: message=${event.error.message}, stack=${event.error.stack}`,
            ),
          );
          break;

        case "turn_end": {
          outputStreamBuffer.forceFlush();

          const err = notify(notifyCmd);
          if (err) {
            console.error(
              styleText("yellow", `\nNotification error: ${err.message}`),
            );
          }

          state.turn = true;
          cli.prompt();
          break;
        }
      }
    }
  };

  consumeAgentEvents();
  cli.prompt();
}

/**
 * Creates a stream buffer for formatting streaming text output.
 * Thin shell: delegates pure logic to createStreamFormatter and handles I/O.
 */
function createStreamBuffer() {
  const formatter = createStreamFormatter();

  function feed(/** @type {string} */ chunk) {
    const { output, warnings } = formatter.feed(chunk);
    for (const s of output) process.stdout.write(s);
    for (const w of warnings) console.error(styleText("yellow", w));
  }

  function forceFlush() {
    const { output, warnings } = formatter.forceFlush();
    for (const s of output) process.stdout.write(s);
    for (const w of warnings) console.error(styleText("yellow", w));
  }

  return { feed, forceFlush };
}
