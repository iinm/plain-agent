import { spawn, spawnSync } from "node:child_process";

/**
 * @typedef {Object} VoiceRecorderConfig
 * @property {string} command - Executable name or absolute path
 * @property {string[]} args
 *   Command arguments. The recorder must write raw 16-bit little-endian
 *   16 kHz mono PCM samples to stdout.
 */

/**
 * @typedef {Object} VoiceInputGeminiConfig
 * @property {"gemini"} provider
 * @property {string} apiKey - Gemini API key
 * @property {string=} model
 *   Gemini Live model name, defaults to "gemini-2.5-flash-live-preview".
 * @property {string=} baseURL
 *   Override the WebSocket base URL. Defaults to the public Gemini endpoint.
 * @property {string=} language
 *   BCP-47 language code passed as `speechConfig.languageCode` (optional).
 * @property {VoiceRecorderConfig=} recorder
 *   Override auto-detection with an explicit recording command.
 */

/**
 * @typedef {VoiceInputGeminiConfig} VoiceInputConfig
 */

/**
 * @typedef {Object} VoiceSessionCallbacks
 * @property {(text: string) => void} onTranscript
 *   Called for each transcript delta received from the server.
 * @property {(error: Error) => void} onError
 *   Called on recorder failure, WebSocket failure, or fatal protocol error.
 * @property {() => void} [onClose]
 *   Called once the session has fully stopped (recorder exited and WebSocket
 *   closed). Always invoked exactly once after `stop()` completes or after a
 *   fatal error.
 */

/**
 * @typedef {Object} VoiceSession
 * @property {() => Promise<void>} stop
 *   Stop the recorder and close the WebSocket. Resolves after both are done.
 */

const DEFAULT_MODEL = "gemini-2.5-flash-live-preview";
const DEFAULT_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Candidate recorder commands tried in order. Each candidate writes raw
 * 16-bit little-endian 16 kHz mono PCM samples to stdout.
 *
 * We prefer commands that produce a quiet, terminal-friendly output on stderr
 * (no progress bars) so that errors are visible but noise is minimal.
 *
 * @returns {VoiceRecorderConfig[]}
 */
export function getRecorderCandidates() {
  const isMac = process.platform === "darwin";
  /** @type {VoiceRecorderConfig[]} */
  const candidates = [];

  if (!isMac) {
    // Linux / BSD: ALSA arecord is ubiquitous.
    candidates.push({
      command: "arecord",
      args: ["-q", "-f", "S16_LE", "-c", "1", "-r", "16000", "-t", "raw"],
    });
  }

  // Cross-platform: sox reads from the default audio device with `-d`.
  candidates.push({
    command: "sox",
    args: [
      "-q",
      "-d",
      "-b",
      "16",
      "-c",
      "1",
      "-r",
      "16000",
      "-e",
      "signed-integer",
      "-t",
      "raw",
      "-",
    ],
  });

  if (isMac) {
    candidates.push({
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "avfoundation",
        "-i",
        ":0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "-",
      ],
    });
  } else {
    candidates.push({
      command: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "alsa",
        "-i",
        "default",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "-",
      ],
    });
  }

  return candidates;
}

/**
 * Return the first recorder candidate whose `command` is found on PATH.
 * Returns `null` when nothing is available.
 *
 * @param {VoiceRecorderConfig[]} [candidates]
 * @returns {VoiceRecorderConfig | null}
 */
export function detectRecorder(candidates = getRecorderCandidates()) {
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate.command)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Check whether an executable exists on PATH without relying on the shell.
 *
 * @param {string} command
 * @returns {boolean}
 */
function isCommandAvailable(command) {
  const probe = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  // Fallback to `/usr/bin/env` style lookup on POSIX. `command -v` requires a
  // shell builtin, so we invoke it through `sh`.
  if (process.platform === "win32") {
    const result = spawnSync(probe, args, { stdio: "ignore" });
    return result.status === 0;
  }
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * Start a voice input session. Spawns a recorder producing raw 16 kHz mono
 * PCM on stdout, opens a WebSocket to Gemini Live, sends the setup message,
 * and streams audio. Transcript deltas are delivered via
 * `callbacks.onTranscript`.
 *
 * @param {object} options
 * @param {VoiceInputConfig} options.config
 * @param {VoiceSessionCallbacks} options.callbacks
 * @returns {VoiceSession}
 */
export function startVoiceSession({ config, callbacks }) {
  const recorder = config.recorder ?? detectRecorder();
  if (!recorder) {
    queueMicrotask(() => {
      callbacks.onError(
        new Error(
          "No voice recorder found. Install one of: arecord, sox, ffmpeg " +
            "(or configure `voiceInput.recorder` in your config).",
        ),
      );
      callbacks.onClose?.();
    });
    return { stop: async () => {} };
  }

  const model = config.model ?? DEFAULT_MODEL;
  const wsUrl = `${config.baseURL ?? DEFAULT_WS_BASE}?key=${encodeURIComponent(config.apiKey)}`;

  let stopped = false;
  let closeEmitted = false;
  const emitClose = () => {
    if (closeEmitted) return;
    closeEmitted = true;
    callbacks.onClose?.();
  };

  // Buffer audio arriving before the WebSocket is open / setupComplete.
  /** @type {Buffer[]} */
  const pendingAudio = [];
  let setupComplete = false;

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  const child = spawn(recorder.command, recorder.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  /** @type {string[]} */
  const recorderStderr = [];
  child.stderr.on("data", (chunk) => {
    recorderStderr.push(chunk.toString("utf8"));
  });

  child.on("error", (err) => {
    if (stopped) return;
    const suffix =
      /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT"
        ? ` (command "${recorder.command}" not found)`
        : "";
    callbacks.onError(
      new Error(`Recorder failed to start${suffix}: ${err.message}`),
    );
    stop();
  });

  child.on("exit", (code, signal) => {
    if (stopped) return;
    if (code !== 0 && signal === null) {
      const stderrText = recorderStderr.join("").trim();
      callbacks.onError(
        new Error(
          `Recorder "${recorder.command}" exited with code ${code}${
            stderrText ? `: ${stderrText}` : ""
          }`,
        ),
      );
    }
    stop();
  });

  child.stdout.on("data", (chunk) => {
    if (stopped) return;
    if (setupComplete && ws.readyState === WebSocket.OPEN) {
      sendAudioChunk(ws, chunk);
    } else {
      pendingAudio.push(chunk);
    }
  });

  ws.addEventListener("open", () => {
    /** @type {Record<string, unknown>} */
    const setupPayload = {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["TEXT"],
      },
      inputAudioTranscription: {},
    };
    if (config.language) {
      setupPayload.speechConfig = { languageCode: config.language };
    }
    try {
      ws.send(JSON.stringify({ setup: setupPayload }));
    } catch (err) {
      callbacks.onError(
        new Error(
          `Failed to send setup message: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      stop();
    }
  });

  ws.addEventListener("message", (event) => {
    if (stopped) return;
    let message;
    try {
      const raw =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(/** @type {ArrayBuffer} */ (event.data)).toString(
              "utf8",
            );
      message = JSON.parse(raw);
    } catch (err) {
      callbacks.onError(
        new Error(
          `Failed to parse server message: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    handleServerMessage(message);
  });

  ws.addEventListener("error", (event) => {
    if (stopped) return;
    const message =
      /** @type {{ message?: string }} */ (event).message ?? "WebSocket error";
    callbacks.onError(new Error(`Gemini Live WebSocket error: ${message}`));
    stop();
  });

  ws.addEventListener("close", (event) => {
    if (!stopped && event.code !== 1000 && event.code !== 1005) {
      const reason = event.reason ? `: ${event.reason}` : "";
      callbacks.onError(
        new Error(`Gemini Live WebSocket closed (code ${event.code}${reason})`),
      );
    }
    stopped = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    emitClose();
  });

  /**
   * @param {unknown} message
   */
  function handleServerMessage(message) {
    if (!isObject(message)) return;
    if ("setupComplete" in message) {
      setupComplete = true;
      // Flush any audio captured before the setup handshake completed.
      while (pendingAudio.length > 0) {
        const chunk = pendingAudio.shift();
        if (chunk && ws.readyState === WebSocket.OPEN) {
          sendAudioChunk(ws, chunk);
        }
      }
      return;
    }
    if ("serverContent" in message && isObject(message.serverContent)) {
      const inputTranscription = message.serverContent.inputTranscription;
      if (
        isObject(inputTranscription) &&
        typeof inputTranscription.text === "string" &&
        inputTranscription.text.length > 0
      ) {
        callbacks.onTranscript(inputTranscription.text);
      }
    }
    // Other server messages (goAway, usageMetadata, etc.) are ignored here —
    // we only care about input transcriptions for the CLI input use case.
  }

  /**
   * @returns {Promise<void>}
   */
  async function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      try {
        ws.close(1000, "client stop");
      } catch {
        // ignore
      }
    }
    emitClose();
  }

  return { stop };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {WebSocket} ws
 * @param {Buffer} chunk
 */
function sendAudioChunk(ws, chunk) {
  const data = chunk.toString("base64");
  const payload = {
    realtimeInput: {
      audio: {
        data,
        mimeType: "audio/pcm;rate=16000",
      },
    },
  };
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Connection may have just closed; ignore — the close handler will clean up.
  }
}
