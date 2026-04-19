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
 *   Gemini Live model name. Defaults to "gemini-3.1-flash-live-preview",
 *   the current audio-to-audio preview model. As of Dec 9, 2025 Google
 *   shut down the older `gemini-2.0-flash-live-001` and
 *   `gemini-live-2.5-flash-preview` endpoints, so those no longer work.
 *
 *   Note: `gemini-3.1-flash-live-preview` rejects `responseModalities:
 *   ["TEXT"]` with a 1011 internal error
 *   (https://github.com/googleapis/python-genai/issues/2238), so we
 *   request `["AUDIO"]` and simply discard the audio response parts —
 *   transcriptions come from `serverContent.inputTranscription`
 *   regardless of the response modality.
 *
 *   Live API model names are preview-track and change over time — see
 *   https://ai.google.dev/gemini-api/docs/live for the current list.
 * @property {string=} baseURL
 *   Override the WebSocket base URL. Defaults to the public Gemini endpoint.
 * @property {VoiceRecorderConfig=} recorder
 *   Override auto-detection with an explicit recording command.
 * @property {string=} toggleKey
 *   Key that toggles voice recording on/off. Accepts `"ctrl-<char>"` where
 *   `<char>` is any printable ASCII character (letters case-insensitive).
 *   Defaults to `"ctrl-g"`. Useful when Ctrl-G is intercepted by a wrapping
 *   program (e.g. neovim's `:terminal`).
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

const DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

/**
 * Test whether `ch` belongs to a script where whitespace is not used as a
 * word separator (so Gemini Live's morpheme-separated output should have
 * those spaces stripped out).
 *
 * Covers the CJK + Japanese kana + Hangul ranges, plus CJK-range punctuation
 * and fullwidth forms. Non-CJK punctuation (.,!? etc.) is intentionally NOT
 * included so "Windows を" style mixed text keeps its space.
 *
 * @param {string} ch
 * @returns {boolean}
 */
function isCJKChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    // CJK Symbols and Punctuation, Hiragana, Katakana, Bopomofo, Hangul Compat
    (code >= 0x3000 && code <= 0x33ff) ||
    // CJK Unified Ideographs Extension A
    (code >= 0x3400 && code <= 0x4dbf) ||
    // CJK Unified Ideographs
    (code >= 0x4e00 && code <= 0x9fff) ||
    // Hangul Syllables
    (code >= 0xac00 && code <= 0xd7af) ||
    // CJK Compatibility Ideographs
    (code >= 0xf900 && code <= 0xfaff) ||
    // Halfwidth/Fullwidth Forms (includes fullwidth Latin and halfwidth kana)
    (code >= 0xff00 && code <= 0xffef) ||
    // CJK Unified Ideographs Extension B (supplementary plane)
    (code >= 0x20000 && code <= 0x2ffff)
  );
}

/**
 * Create a streaming normalizer that drops whitespace sitting between two
 * CJK characters. Gemini Live sends Japanese transcripts as
 * morpheme-separated text ("そう 、 声 で 入力 できる") even though
 * Japanese doesn't use inter-word spaces; mixed strings like "Windows を
 * 使う" should still keep the space between the Latin and Japanese tokens.
 *
 * The normalizer is stateful: whitespace at the tail of a delta is held
 * until the following delta arrives so we can decide based on the *next*
 * real character. Call `flush()` when no more input is expected.
 *
 * @returns {{
 *   push: (text: string) => string,
 *   flush: () => string,
 * }}
 */
export function createCJKSpaceNormalizer() {
  /** @type {string} */
  let prevChar = "";
  /** @type {string} */
  let pendingSpaces = "";

  /**
   * @param {string} ch
   * @returns {boolean}
   */
  const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\u3000";

  return {
    push(text) {
      let out = "";
      for (const ch of text) {
        if (isSpace(ch)) {
          pendingSpaces += ch;
          continue;
        }
        if (pendingSpaces.length > 0) {
          if (!(isCJKChar(prevChar) && isCJKChar(ch))) {
            out += pendingSpaces;
          }
          pendingSpaces = "";
        }
        out += ch;
        prevChar = ch;
      }
      return out;
    },
    flush() {
      const out = pendingSpaces;
      pendingSpaces = "";
      prevChar = "";
      return out;
    },
  };
}

/**
 * Parsed voice toggle key: the raw byte value that appears on stdin in raw
 * mode, plus a human-readable label for UI messages.
 *
 * @typedef {Object} VoiceToggleKey
 * @property {number} byte
 * @property {string} label
 */

/**
 * Parse a configured toggle-key string (e.g. "ctrl-g", "ctrl-o", "ctrl-\\")
 * into the raw ASCII byte that the terminal sends in raw mode.
 *
 * Only Ctrl-<char> bindings are supported because that is the only family of
 * key combinations that the terminal encodes as a single deterministic byte
 * on stdin without an `ESC` prefix. Function keys, Alt+, and multi-byte
 * sequences would need a full key decoder (which the pre-readline pipeline
 * deliberately avoids).
 *
 * Throws on malformed input so misconfiguration surfaces at startup, not at
 * keypress time.
 *
 * @param {string | undefined} spec
 * @returns {VoiceToggleKey}
 */
export function parseVoiceToggleKey(spec) {
  const raw = (spec ?? "ctrl-g").trim().toLowerCase();
  const match = /^ctrl-(.)$/.exec(raw);
  if (!match) {
    throw new Error(
      `Invalid voiceInput.toggleKey "${spec}". Expected "ctrl-<char>" (e.g. "ctrl-g", "ctrl-o", "ctrl-\\").`,
    );
  }
  const ch = match[1];
  const code = ch.charCodeAt(0);
  // Map printable ASCII to its Ctrl-modified byte: Ctrl-<@..._> => 0x00..0x1f.
  // Letters a-z map to 0x01..0x1a; the symbols [ \ ] ^ _ map to 0x1b..0x1f;
  // `@` and `` ` `` both map to 0x00 (NUL) which we disallow because NUL is
  // frequently dropped by terminals and intermediate layers.
  let byte;
  if (code >= 0x61 && code <= 0x7a) {
    byte = code - 0x60; // a-z -> 0x01-0x1a
  } else if (code >= 0x5b && code <= 0x5f) {
    byte = code - 0x40; // [ \ ] ^ _ -> 0x1b-0x1f
  } else {
    throw new Error(
      `Unsupported voiceInput.toggleKey "${spec}". Use ctrl-<letter> or ctrl-<[ \\ ] ^ _>.`,
    );
  }
  // Reject bytes that readline / the terminal already reserve.
  // Ctrl-C / Ctrl-D are handled separately; Ctrl-J (0x0a) / Ctrl-M (0x0d) are
  // newline/carriage return; Ctrl-I (0x09) is TAB; Ctrl-S / Ctrl-Q are flow
  // control. Letting the user pick those would break line editing.
  const reserved = new Set([
    0x03, // Ctrl-C
    0x04, // Ctrl-D
    0x09, // Tab
    0x0a, // LF
    0x0d, // CR
    0x11, // Ctrl-Q (XON)
    0x13, // Ctrl-S (XOFF)
  ]);
  if (reserved.has(byte)) {
    throw new Error(
      `voiceInput.toggleKey "${spec}" conflicts with a reserved terminal/readline key.`,
    );
  }
  return { byte, label: `Ctrl-${ch.toUpperCase()}` };
}

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

  // Verify the recorder command actually exists before opening the WebSocket.
  // This avoids a dangling outbound connection (which would hang in offline
  // environments like CI) when the user misconfigures `voiceInput.recorder`.
  if (!isCommandAvailable(recorder.command)) {
    queueMicrotask(() => {
      callbacks.onError(
        new Error(
          `Voice recorder command "${recorder.command}" not found on PATH.`,
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

  // Gemini Live returns Japanese transcripts as morpheme-separated text
  // (e.g. "そう 、 声 で 入力 できる"), so strip whitespace sitting between
  // two CJK characters before forwarding deltas to the consumer.
  const normalizer = createCJKSpaceNormalizer();

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
    // `responseModalities: ["AUDIO"]` is intentional: the current
    // `gemini-3.1-flash-live-preview` model returns a 1011 internal
    // error when asked for TEXT-only output
    // (https://github.com/googleapis/python-genai/issues/2238). We don't
    // actually consume the audio output — `inputAudioTranscription`
    // delivers the user speech transcript via `serverContent
    // .inputTranscription` regardless of `responseModalities`, and we
    // discard `modelTurn` parts in `handleServerMessage`.
    //
    // `speechConfig` is omitted: the audio output is discarded, so the
    // default voice is fine and configuring it would just cost bytes.
    const setupPayload = {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
      },
      inputAudioTranscription: {},
    };
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
        const normalized = normalizer.push(inputTranscription.text);
        if (normalized.length > 0) {
          callbacks.onTranscript(normalized);
        }
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
