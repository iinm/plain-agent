/**
 * @import { Agent } from "../agent"
 * @import { ClaudeCodePlugin } from "../claudeCodePlugin.mjs"
 * @import { Tool, SandboxModeProvider } from "../tool"
 */

import readline from "node:readline";
import { styleText } from "node:util";
import { persistSessionEvent, sessionFileExists } from "../sessionStore.mjs";
import { appendUsageRecord, buildUsageRecord } from "../usageStore.mjs";
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
 * @property {{ command: string; args?: string[] } | undefined} notifyCmd
 * @property {boolean} sandbox
 * @property {() => Promise<void>} onStop
 * @property {ClaudeCodePlugin[]} [claudeCodePlugins]
 * @property {Tool & SandboxModeProvider} [execCommandTool]
 */

/**
 * Persist the session's cost summary to the usage log.
 * Failures are logged but never thrown so exit is not blocked.
 *
 * @param {import("../costTracker.mjs").CostSummary} summary
 * @param {{ sessionId: string, modelName: string, startTime: Date }} meta
 */
async function persistUsage(summary, { sessionId, modelName, startTime }) {
  try {
    const record = buildUsageRecord({
      sessionId,
      mode: "interactive",
      modelName,
      workingDir: process.cwd(),
      costSummary: summary,
      now: startTime,
    });
    if (!record) return;
    await appendUsageRecord(record);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      styleText("yellow", `Warning: failed to record usage: ${message}`),
    );
  }
}

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
  onStop,
  claudeCodePlugins,
  execCommandTool,
}) {
  /** @type {{ turn: boolean, multiLineBuffer: string[] | null, subagentName: string, toolSpinnerIndex: number, toolSpinnerLastTime: number, thinkingBuffer: string, thinkingRenderedLines: number }} */
  const state = {
    turn: true,
    multiLineBuffer: null,
    subagentName: agent.getActiveSubagent()?.name ?? "",
    toolSpinnerIndex: 0,
    toolSpinnerLastTime: 0,
    thinkingBuffer: "",
    thinkingRenderedLines: 0,
  };

  // Number of most recent thinking lines to keep visible while streaming.
  const THINKING_VISIBLE_LINES = 3;

  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const SPINNER_INTERVAL_MS = 80;

  // Create the stream buffer instance for this session
  const streamBuffer = createStreamBuffer();

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
    const summary = agent.getCostSummary();
    const hasSessionFile = await sessionFileExists(sessionId);
    if (hasSessionFile) {
      await persistSessionEvent(sessionId, {
        type: "session_end",
        cost: summary,
      });
    }
    await persistUsage(summary, { sessionId, modelName, startTime });
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

  // Double-press Ctrl-D exit confirmation
  let lastCtrlDAttempt = 0;
  const EXIT_CONFIRM_TIMEOUT = 1500;

  /** @type {import("node:readline").Interface} */
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
    lastCtrlDAttempt = 0;
  };

  const handleCtrlD = () => {
    // User turn with non-empty input: ignore Ctrl-D entirely.
    if (state.turn && (cli.line.length > 0 || state.multiLineBuffer !== null)) {
      return;
    }

    const now = Date.now();
    if (now - lastCtrlDAttempt < EXIT_CONFIRM_TIMEOUT) {
      handleExit();
      return;
    }
    lastCtrlDAttempt = now;
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
  }

  let currentCliPrompt = getCliPrompt(state.subagentName);
  cli = readline.createInterface({
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
  process.on("SIGTERM", handleExit);
  process.on("SIGHUP", handleExit);

  const handleCommand = createCommandHandler({
    agent,
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

  // Erase the currently rendered thinking lines and reset the counter.
  const clearThinking = () => {
    if (state.thinkingRenderedLines > 0) {
      // Clear the current line, then move up and clear each remaining line.
      let seq = "\r\x1b[2K";
      for (let i = 1; i < state.thinkingRenderedLines; i += 1) {
        seq += "\x1b[1F\x1b[2K";
      }
      process.stdout.write(seq);
    }
    state.thinkingRenderedLines = 0;
  };

  // Redraw the last few thinking lines in place from the buffer.
  const renderThinking = () => {
    clearThinking();
    const lines = state.thinkingBuffer
      .split("\n")
      .slice(-THINKING_VISIBLE_LINES);
    process.stdout.write(
      lines.map((line) => styleText("gray", line)).join("\n"),
    );
    state.thinkingRenderedLines = lines.length;
  };

  /**
   * Render a streaming partial message content chunk.
   * @param {import("../model").PartialMessageContent} partialContent
   */
  const handlePartialMessageContent = (partialContent) => {
    if (partialContent.type === "thinking") {
      // Fall back to no rendering when we cannot control the cursor.
      if (!process.stdout.isTTY) {
        return;
      }
      if (partialContent.position === "start") {
        state.thinkingBuffer = "";
        state.thinkingRenderedLines = 0;
      }
      if (partialContent.content) {
        state.thinkingBuffer += partialContent.content;
        renderThinking();
      }
      if (partialContent.position === "stop") {
        clearThinking();
        state.thinkingBuffer = "";
      }
      return;
    }

    if (partialContent.position === "start") {
      const subagentPrefix = state.subagentName
        ? styleText("cyan", `[${state.subagentName}]\n`)
        : "";
      const partialContentStr = styleText("gray", `<${partialContent.type}>`);

      if (partialContent.type === "tool_use") {
        state.toolSpinnerIndex = 0;
        state.toolSpinnerLastTime = Date.now();
        process.stdout.write(
          `\n${subagentPrefix}${partialContentStr} ${styleText("cyan", SPINNER_FRAMES[0])}`,
        );
      } else {
        console.log(`\n${subagentPrefix}${partialContentStr}`);
      }
    }
    if (partialContent.content) {
      if (partialContent.type === "tool_use") {
        const now = Date.now();
        if (now - state.toolSpinnerLastTime >= SPINNER_INTERVAL_MS) {
          state.toolSpinnerIndex =
            (state.toolSpinnerIndex + 1) % SPINNER_FRAMES.length;
          state.toolSpinnerLastTime = now;
          process.stdout.write(
            `\r\x1b[K${styleText("gray", `<${partialContent.type}>`)} ${styleText("cyan", SPINNER_FRAMES[state.toolSpinnerIndex])}`,
          );
        }
      } else if (partialContent.type === "text") {
        streamBuffer.feed(partialContent.content);
      } else {
        process.stdout.write(partialContent.content);
      }
    }
    if (partialContent.position === "stop") {
      if (partialContent.type === "tool_use") {
        // Clear current line, move up one line, and clear that line too
        process.stdout.write("\x1b[2K\x1b[1F\x1b[2K");
      } else {
        // Flush any buffered text before printing the closing tag
        streamBuffer.forceFlush();
        console.log(styleText("gray", `\n</${partialContent.type}>`));
      }
    }
  };

  // Consume the agent's event stream. Because events are pulled one at a time
  // and awaited in order, output is naturally serialized — no manual
  // sequential executor is needed.
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
          // Flush any remaining stream buffer content
          streamBuffer.forceFlush();

          const err = notify(notifyCmd);
          if (err) {
            console.error(
              styleText("yellow", `\nNotification error: ${err.message}`),
            );
          }

          // Defer prompt rendering to ensure terminal output is visible
          await new Promise((resolve) => setImmediate(resolve));

          state.turn = true;
          cli.prompt();
          break;
        }
      }
    }
  };
  consumeAgentEvents();

  cli.prompt();

  // Register cleanup handlers
  process.on("exit", cleanup);
  process.on("SIGTERM", cleanup);
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
