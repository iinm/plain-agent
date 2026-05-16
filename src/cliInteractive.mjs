/**
 * @import { UserEventEmitter, AgentEventEmitter, AgentCommands } from "./agent"
 * @import { ClaudeCodePlugin } from "./claudeCodePlugin.mjs"
 * @import { VoiceInputConfig, VoiceSession } from "./voiceInput.mjs"
 */

import readline from "node:readline";
import { styleText } from "node:util";
import { createCommandHandler } from "./cliCommands.mjs";
import { createCompleter, SLASH_COMMANDS } from "./cliCompleter.mjs";
import {
  formatCostSummary,
  formatMarkdownTable,
  formatProviderTokenUsage,
  printMessage,
} from "./cliFormatter.mjs";
import { createInterruptTransform } from "./cliInterruptTransform.mjs";
import { createMuteTransform } from "./cliMuteTransform.mjs";
import { createPasteHandler } from "./cliPasteTransform.mjs";
import { appendUsageRecord, buildUsageRecord } from "./usageStore.mjs";
import { createSequentialExecutor } from "./utils/createSequentialExecutor.mjs";
import { notify } from "./utils/notify.mjs";
import { parseVoiceToggleKey, startVoiceSession } from "./voiceInput.mjs";

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
 * @property {Date} startTime
 * @property {{ command: string; args?: string[] } | undefined} notifyCmd
 * @property {boolean} sandbox
 * @property {() => Promise<void>} onStop
 * @property {ClaudeCodePlugin[]} [claudeCodePlugins]
 * @property {VoiceInputConfig} [voiceInput]
 */

/**
 * Persist the session's cost summary to the usage log.
 * Failures are logged but never thrown so exit is not blocked.
 *
 * @param {import("./costTracker.mjs").CostSummary} summary
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
  userEventEmitter,
  agentEventEmitter,
  agentCommands,
  sessionId,
  modelName,
  startTime,
  notifyCmd,
  sandbox,
  onStop,
  claudeCodePlugins,
  voiceInput,
}) {
  /** @type {{ turn: boolean, multiLineBuffer: string[] | null, subagentName: string }} */
  const state = {
    turn: true,
    multiLineBuffer: null,
    subagentName: agentCommands.getActiveSubagent()?.name ?? "",
  };

  /**
   * Active voice input session, or null when not recording.
   * @type {{ session: VoiceSession, startCursor: number, transcriptLength: number } | null}
   */
  let voice = null;

  // Create the table buffer instance for this session
  const tableBuffer = createTableBuffer();

  // Parse the voice toggle key once at startup so misconfiguration fails
  // loudly instead of silently falling back.
  const voiceToggle = parseVoiceToggleKey(voiceInput?.toggleKey);

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
    const summary = agentCommands.getCostSummary();
    console.log();
    console.log(formatCostSummary(summary));
    await persistUsage(summary, { sessionId, modelName, startTime });
    await agentCommands.flushSessionPersistence();
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

  const stopVoiceSession = async () => {
    if (!voice) return;
    const current = voice;
    voice = null;
    await current.session.stop();
    cli.setPrompt(currentCliPrompt);
    // @ts-expect-error - internal property
    cli._refreshLine?.();
  };

  const handleVoiceToggle = () => {
    // Ignore while the agent is working.
    if (!state.turn) return;

    if (voice) {
      stopVoiceSession();
      return;
    }

    if (!voiceInput) {
      cli.setPrompt(
        getCliPrompt(
          state.subagentName,
          styleText(
            "yellow",
            `Voice input not configured. Set \`voiceInput\` in your config to enable ${voiceToggle.label}.`,
          ),
        ),
      );
      cli.prompt(true);
      return;
    }

    const startCursor = cli.cursor;
    const session = startVoiceSession({
      config: voiceInput,
      callbacks: {
        onTranscript: (delta) => {
          if (!voice) return;
          const insertAt = voice.startCursor + voice.transcriptLength;
          // Insert delta at the recording's insertion point. User input is
          // swallowed while recording, so the buffer around `insertAt` is
          // stable.
          const before = cli.line.slice(0, insertAt);
          const after = cli.line.slice(insertAt);
          // `line` and `cursor` are declared readonly in the Node typings but
          // are writable at runtime — the existing code already patches
          // `_refreshLine` in the same way.
          const mutableCli = /** @type {{ line: string, cursor: number }} */ (
            /** @type {unknown} */ (cli)
          );
          mutableCli.line = before + delta + after;
          mutableCli.cursor = insertAt + delta.length;
          voice.transcriptLength += delta.length;
          // @ts-expect-error - internal property
          cli._refreshLine?.();
        },
        onError: (err) => {
          voice = null;
          cli.setPrompt(
            getCliPrompt(
              state.subagentName,
              styleText("red", `Voice input error: ${err.message}`),
            ),
          );
          cli.prompt(true);
        },
        onClose: () => {
          if (!voice) return;
          voice = null;
          cli.setPrompt(currentCliPrompt);
          // @ts-expect-error - internal property
          cli._refreshLine?.();
        },
      },
    });
    voice = { session, startCursor, transcriptLength: 0 };
    cli.setPrompt(
      getCliPrompt(
        state.subagentName,
        styleText(["red", "bold"], `● REC  (${voiceToggle.label} to stop)`),
      ),
    );
    // @ts-expect-error - internal property
    cli._refreshLine?.();
  };

  const handleCtrlC = () => {
    // Stop voice recording first if active.
    if (voice) {
      stopVoiceSession();
      return;
    }

    // Agent turn: pause auto-approve; do not clear input.
    if (!state.turn) {
      agentCommands.pauseAutoApprove();
      console.error(
        styleText(
          "yellow",
          "\n\n⚠️ Ctrl-C: Auto-approve paused. Finishing current tool...\nPress Ctrl-D twice to exit.\n",
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
  //   stdin -> interrupt (Ctrl-C / Ctrl-D) -> mute (voice recording) -> paste (bracketed paste) -> readline
  const interrupt = createInterruptTransform({
    onCtrlC: handleCtrlC,
    onCtrlD: handleCtrlD,
    onVoiceToggle: handleVoiceToggle,
    voiceToggleByte: voiceToggle.byte,
  });
  // While a voice session is recording, swallow all stdin bytes other than
  // Ctrl-C / Ctrl-D / the voice toggle key so transcript insertion stays
  // consistent.
  const mute = createMuteTransform({ isMuted: () => voice !== null });
  const paste = createPasteHandler();

  process.stdin.pipe(interrupt).pipe(mute).pipe(paste.transform);

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
      } else if (partialContent.type === "text") {
        tableBuffer.feed(partialContent.content);
      } else {
        process.stdout.write(partialContent.content);
      }
    }
    if (partialContent.position === "stop") {
      console.log(styleText("gray", `\n</${partialContent.type}>`));
    }
  });

  const enqueueOutput = createSequentialExecutor();

  agentEventEmitter.on("message", (message) => {
    enqueueOutput(() =>
      printMessage(message).catch((err) => {
        console.error(
          styleText("red", `Error rendering message: ${err.message}`),
        );
      }),
    );
  });

  agentEventEmitter.on("toolUseRequest", () => {
    cli.setPrompt(
      getCliPrompt(
        state.subagentName,
        styleText(
          "yellow",
          "Approve tool calls? (y = allow once, Y = allow in this session, or feedback)",
        ),
      ),
    );
  });

  agentEventEmitter.on("subagentSwitched", (subagent) => {
    state.subagentName = subagent?.name ?? "";
    currentCliPrompt = getCliPrompt(state.subagentName);
    cli.setPrompt(currentCliPrompt);
  });

  agentEventEmitter.on("providerTokenUsage", (usage) => {
    enqueueOutput(() => {
      console.log(formatProviderTokenUsage(usage));
    });
  });

  agentEventEmitter.on("error", (error) => {
    console.error(
      styleText(
        "red",
        `\nError: message=${error.message}, stack=${error.stack}`,
      ),
    );
  });

  agentEventEmitter.on("turnEnd", async () => {
    // Flush any remaining table buffer content
    tableBuffer.forceFlush();

    const err = notify(notifyCmd);
    if (err) {
      console.error(
        styleText("yellow", `\nNotification error: ${err.message}`),
      );
    }

    // Wait for all output operations to complete
    await enqueueOutput(() => {});

    // Defer prompt rendering to ensure terminal output is visible
    await new Promise((resolve) => setImmediate(resolve));

    state.turn = true;
    cli.prompt();
  });

  cli.prompt();

  // Register cleanup handlers
  process.on("exit", cleanup);
  process.on("SIGTERM", cleanup);
}

/**
 * Creates a table buffer for detecting and formatting markdown tables
 * in streaming text output.
 */
function createTableBuffer() {
  /** @type {string} - Accumulated incomplete line */
  let pendingLine = "";
  /** @type {string[]} - Lines of the current table being detected */
  const tableLines = [];
  /** @type {boolean} - Inside a code block (```) */
  let inCodeBlock = false;
  const MAX_TABLE_LINES = 200;
  /**
   * Check if a line starts a table.
   * @param {string} line
   * @returns {boolean}
   */
  function isTableStart(line) {
    const trimmed = line.trimStart();
    return trimmed.startsWith("|");
  }

  /**
   * Check if a line continues a table.
   * This is a heuristic: any line containing a pipe character is considered
   * a potential table row. This may produce false positives for non-table
   * content with pipes (e.g., "Choose A | B | C").
   * @param {string} line
   * @returns {boolean}
   */
  function isTableContinuation(line) {
    return line.includes("|");
  }

  /**
   * Feed a text chunk to the buffer.
   * @param {string} chunk
   */
  function feed(chunk) {
    pendingLine += chunk;

    // Process complete lines (those containing newlines)
    while (pendingLine.includes("\n")) {
      const idx = pendingLine.indexOf("\n");
      const line = pendingLine.slice(0, idx); // Exclude the newline
      pendingLine = pendingLine.slice(idx + 1);
      processLine(`${line}\n`); // Add newline back for output
    }

    // If not buffering a table and pendingLine has no pipe, output immediately
    // This ensures non-table text is streamed without delay
    if (tableLines.length === 0 && !pendingLine.includes("|")) {
      process.stdout.write(pendingLine);
      pendingLine = "";
    }
  }

  /**
   * Process a complete line.
   * @param {string} line - Line including trailing newline
   */
  function processLine(line) {
    // Code block detection
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      flushTable(); // Code block terminates any ongoing table
      process.stdout.write(line);
      return;
    }

    if (inCodeBlock) {
      process.stdout.write(line);
      return;
    }

    // Table start: line begins with pipe
    if (isTableStart(line)) {
      tableLines.push(line);

      // Buffer limit check
      if (tableLines.length > MAX_TABLE_LINES) {
        flushTableAsIs();
      }
      return;
    }

    // Table continuation: line contains pipe (for rows without leading pipe)
    if (tableLines.length > 0 && isTableContinuation(line)) {
      tableLines.push(line);
      if (tableLines.length > MAX_TABLE_LINES) {
        flushTableAsIs();
      }
      return;
    }

    // Table ended: format and flush buffer, then output current line
    flushTable();
    process.stdout.write(line);
  }

  /**
   * Flush table buffer with formatting.
   */
  function flushTable() {
    if (tableLines.length === 0) return;

    // Separate trailing empty lines (preserve spacing after table)
    /** @type {string[]} */
    const trailingEmpty = [];
    while (tableLines.length > 0 && tableLines.at(-1)?.trim() === "") {
      const line = tableLines.pop();
      if (line !== undefined) trailingEmpty.unshift(line);
    }

    if (tableLines.length > 0) {
      // Remove trailing newlines for formatting, then add them back
      const rawLines = tableLines.map((l) =>
        l.endsWith("\n") ? l.slice(0, -1) : l,
      );
      try {
        const formatted = formatMarkdownTable(rawLines);
        process.stdout.write(`${formatted}\n`);
      } catch (err) {
        // Fallback: output raw lines if formatting fails
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          styleText("yellow", `Warning: Table formatting failed: ${message}`),
        );
        for (const line of tableLines) {
          process.stdout.write(line);
        }
      }
    }

    tableLines.length = 0;

    // Output trailing empty lines
    for (const empty of trailingEmpty) {
      process.stdout.write(empty);
    }
  }

  /**
   * Flush table buffer without formatting (for oversized tables).
   */
  function flushTableAsIs() {
    if (tableLines.length === 0) return;
    for (const line of tableLines) {
      process.stdout.write(line);
    }
    tableLines.length = 0;
  }

  /**
   * Force flush any pending content (call on turn end).
   */
  function forceFlush() {
    // Process any remaining pending line
    if (pendingLine.length > 0) {
      // If we have a table buffer, add pending line to it or output directly
      if (tableLines.length > 0) {
        tableLines.push(`${pendingLine}\n`);
      } else {
        process.stdout.write(pendingLine);
      }
      pendingLine = "";
    }
    flushTable();
  }

  return { feed, forceFlush };
}
