import { spawn, spawnSync } from "node:child_process";

/**
 * @typedef {Object} VoiceRecorderConfig
 * @property {string} command
 * @property {string[]} args
 *   Must write raw 16-bit little-endian mono PCM to stdout at the sample
 *   rate required by the chosen provider (24 kHz for OpenAI, 16 kHz for
 *   Gemini).
 */

/**
 * @typedef {Object} VoiceSessionCallbacks
 * @property {(text: string) => void} onTranscript
 * @property {(error: Error) => void} onError
 * @property {() => void} [onClose]
 */

/**
 * @typedef {Object} VoiceSession
 * @property {() => Promise<void>} stop
 */

/**
 * @typedef {Object} RecorderHandle
 * @property {() => void} stop
 */

export const VOICE_DEBUG = process.env.PLAIN_VOICE_DEBUG === "1";

/**
 * @param {number} sampleRate
 * @returns {VoiceRecorderConfig[]}
 */
export function getRecorderCandidates(sampleRate) {
  const rate = String(sampleRate);
  const isMac = process.platform === "darwin";
  /** @type {VoiceRecorderConfig[]} */
  const candidates = [];

  if (!isMac) {
    candidates.push({
      command: "arecord",
      args: ["-q", "-f", "S16_LE", "-c", "1", "-r", rate, "-t", "raw"],
    });
  }

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
      rate,
      "-e",
      "signed-integer",
      "-t",
      "raw",
      "-",
    ],
  });

  const ffmpegInput = isMac
    ? ["-f", "avfoundation", "-i", ":0"]
    : ["-f", "alsa", "-i", "default"];
  candidates.push({
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      ...ffmpegInput,
      "-ac",
      "1",
      "-ar",
      rate,
      "-f",
      "s16le",
      "-",
    ],
  });

  return candidates;
}

/**
 * @param {VoiceRecorderConfig[]} candidates
 * @returns {VoiceRecorderConfig | null}
 */
export function detectRecorder(candidates) {
  return candidates.find((c) => isCommandAvailable(c.command)) ?? null;
}

/**
 * @param {string} command
 */
export function isCommandAvailable(command) {
  if (process.platform === "win32") {
    const result = spawnSync("where", [command], { stdio: "ignore" });
    return result.status === 0;
  }
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * Spawn a recorder subprocess that emits raw PCM on stdout, and wire its
 * lifecycle events to the provided callbacks. This is purely transport
 * plumbing — it knows nothing about any specific STT provider.
 *
 * @param {object} options
 * @param {VoiceRecorderConfig} options.recorder
 * @param {(chunk: Buffer) => void} options.onAudio
 * @param {(error: Error) => void} options.onError
 * @param {() => void} options.onExit - Called after the recorder subprocess exits (for any reason).
 * @returns {RecorderHandle}
 */
export function startRecorder({ recorder, onAudio, onError, onExit }) {
  const child = spawn(recorder.command, recorder.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  /** @type {string[]} */
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  child.on("error", (err) => {
    const suffix =
      /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT"
        ? ` (command "${recorder.command}" not found)`
        : "";
    onError(new Error(`Recorder failed to start${suffix}: ${err.message}`));
  });

  child.on("exit", (code, signal) => {
    if (code !== 0 && signal === null) {
      const stderrText = stderrChunks.join("").trim();
      onError(
        new Error(
          `Recorder "${recorder.command}" exited with code ${code}${
            stderrText ? `: ${stderrText}` : ""
          }`,
        ),
      );
    }
    onExit();
  });

  child.stdout.on("data", onAudio);

  return {
    stop() {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Report an error asynchronously and return an already-terminated session.
 *
 * Calls `onError` followed by `onClose` in a microtask, ensuring the caller
 * receives a valid {@link VoiceSession} synchronously while still notifying
 * the consumer of the failure.
 *
 * @param {VoiceSessionCallbacks} callbacks
 * @param {Error} error
 * @returns {VoiceSession}
 */
export function failVoiceSessionAsync(callbacks, error) {
  queueMicrotask(() => {
    callbacks.onError(error);
    callbacks.onClose?.();
  });
  return { stop: async () => {} };
}

/**
 * Provider-specific hook contract for {@link startWebSocketVoiceSession}.
 *
 * Each hook is called at a specific point in the session lifecycle:
 *
 * 1. **Construction** – `buildWsUrl` (and optionally `buildWsOptions`) are
 *    invoked immediately to create the WebSocket.
 * 2. **Open** – `buildSetupMessage` is sent as the first JSON message once the
 *    WebSocket opens.
 * 3. **Ready** – `isReadyMessage` is tested on every incoming message until it
 *    returns `true`. At that point the session transitions to *ready* and any
 *    buffered audio chunks are flushed.
 * 4. **Streaming** – `buildAudioPayload` is called for every recorder chunk
 *    while the WebSocket is open and ready.
 * 5. **Error extraction** – `extractError` is checked on every message before
 *    transcript extraction. If it returns a string, the session reports an
 *    error and drops the message.
 * 6. **Transcription** – `extractTranscript` is called on every message after
 *    the session is ready. Non-empty results are pushed through the CJK
 *    space normalizer and then forwarded to `onTranscript`.
 *
 * @template TConfig
 * @typedef {Object} VoiceProviderHooks
 * @property {string} label - Human-readable provider name (used in logs and
 *   error messages).
 * @property {number} sampleRate - PCM sample rate expected by the provider
 *   (e.g. 16000 for Gemini, 24000 for OpenAI). Passed to the recorder and
 *   `buildAudioPayload`.
 * @property {(config: TConfig) => string} buildWsUrl - Returns the full
 *   WebSocket URL, including any query parameters.
 * @property {(config: TConfig) => { headers?: Record<string, string> }} [buildWsOptions]
 *   - Returns optional per-provider WebSocket constructor options. Node's
 *   global WebSocket (undici) accepts a non-standard `headers` option that
 *   is not declared in the standard typings.
 * @property {(config: TConfig) => object} buildSetupMessage - Returns the
 *   first JSON message sent immediately after the WebSocket opens.
 * @property {(message: unknown) => boolean} isReadyMessage - Returns `true`
 *   when the given server message signals that the provider is ready to
 *   receive audio.
 * @property {(message: unknown) => string | undefined} extractTranscript -
 *   Extracts a transcript delta from a server message. Return `undefined`
 *   when the message carries no transcript.
 * @property {(message: unknown) => string | undefined} [extractError] -
 *   Extracts an error description from a server message. Return `undefined`
 *   when the message carries no error.
 * @property {(chunk: Buffer, sampleRate: number) => object} buildAudioPayload -
 *   Wraps a raw PCM chunk into the provider-specific JSON payload. The
 *   `sampleRate` argument is the same value as `hooks.sampleRate`.
 */

/**
 * Shared WebSocket voice session implementation used by both Gemini and
 * OpenAI drivers.
 *
 * Responsibilities of this function:
 * - Detect and start a suitable system audio recorder.
 * - Establish the provider WebSocket connection.
 * - Manage the lifecycle (setup → ready → streaming → close).
 * - Buffer audio chunks while the connection is not yet ready.
 * - Apply CJK space normalization to transcript text.
 *
 * Responsibilities of the caller (the driver):
 * - Provide a {@link VoiceProviderHooks} object that knows the provider's
 *   wire protocol (URLs, headers, message schemas).
 * - Supply `config` and `callbacks` from the user's call site.
 *
 * @template TConfig
 * @param {object} options
 * @param {VoiceProviderHooks<TConfig>} options.hooks
 * @param {TConfig & { recorder?: VoiceRecorderConfig }} options.config
 * @param {VoiceSessionCallbacks} options.callbacks
 * @returns {VoiceSession}
 */
export function startWebSocketVoiceSession({ hooks, config, callbacks }) {
  const recorder =
    config.recorder ?? detectRecorder(getRecorderCandidates(hooks.sampleRate));
  if (!recorder) {
    return failVoiceSessionAsync(
      callbacks,
      new Error(
        "No voice recorder found. Install arecord, sox, or ffmpeg (or set `voiceInput.recorder`).",
      ),
    );
  }

  if (!isCommandAvailable(recorder.command)) {
    return failVoiceSessionAsync(
      callbacks,
      new Error(
        `Voice recorder command "${recorder.command}" not found on PATH.`,
      ),
    );
  }

  let stopped = false;
  let closeEmitted = false;
  let ready = false;
  /** @type {Buffer[]} */
  const pendingAudio = [];
  const normalizer = createCJKSpaceNormalizer();

  function emitClose() {
    if (closeEmitted) return;
    closeEmitted = true;
    callbacks.onClose?.();
  }

  const wsUrl = hooks.buildWsUrl(config);
  const wsOptions = hooks.buildWsOptions?.(config);

  // Node's global WebSocket (undici) accepts a non-standard `headers`
  // option. The built-in typings only declare the standards-compliant
  // constructor, so cast through `WebSocket`-as-constructor.
  const Ctor = /** @type {new (url: string, opts?: unknown) => WebSocket} */ (
    /** @type {unknown} */ (WebSocket)
  );
  const ws = new Ctor(wsUrl, wsOptions);
  ws.binaryType = "arraybuffer";

  const rec = startRecorder({
    recorder,
    onAudio(chunk) {
      if (stopped) return;
      if (ready && ws.readyState === WebSocket.OPEN) {
        sendAudio(chunk);
      } else {
        pendingAudio.push(chunk);
      }
    },
    onError(err) {
      if (!stopped) callbacks.onError(err);
      stop();
    },
    onExit() {
      stop();
    },
  });

  /**
   * @param {Buffer} chunk
   */
  function sendAudio(chunk) {
    const payload = hooks.buildAudioPayload(chunk, hooks.sampleRate);
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      if (VOICE_DEBUG) {
        process.stderr.write(
          `[voiceInput] sendAudio dropped: ${formatError(err)}\n`,
        );
      }
    }
  }

  ws.addEventListener("open", () => {
    const setup = hooks.buildSetupMessage(config);
    try {
      ws.send(JSON.stringify(setup));
    } catch (err) {
      callbacks.onError(
        new Error(`Failed to send setup message: ${formatError(err)}`),
      );
      stop();
    }
  });

  ws.addEventListener("message", (event) => {
    if (stopped) return;
    let raw = "";
    let message;
    try {
      raw =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(/** @type {ArrayBuffer} */ (event.data)).toString(
              "utf8",
            );
      message = JSON.parse(raw);
    } catch (err) {
      callbacks.onError(
        new Error(`Failed to parse server message: ${formatError(err)}`),
      );
      return;
    }
    if (!isObjectLike(message)) return;
    if (VOICE_DEBUG) {
      process.stderr.write(`[voiceInput] <- ${raw.slice(0, 800)}\n`);
    }

    const errorText = hooks.extractError?.(message);
    if (errorText) {
      callbacks.onError(new Error(`${hooks.label} error: ${errorText}`));
      return;
    }

    if (!ready && hooks.isReadyMessage(message)) {
      ready = true;
      for (const chunk of pendingAudio.splice(0)) {
        if (ws.readyState === WebSocket.OPEN) sendAudio(chunk);
      }
      return;
    }

    const transcript = hooks.extractTranscript(message);
    if (transcript && transcript.length > 0) {
      const normalized = normalizer.push(transcript);
      if (normalized.length > 0) {
        callbacks.onTranscript(normalized);
      }
    }
  });

  ws.addEventListener("error", (event) => {
    if (stopped) return;
    const message =
      /** @type {{ message?: string }} */ (event).message ?? "WebSocket error";
    callbacks.onError(new Error(`${hooks.label} WebSocket error: ${message}`));
    stop();
  });

  ws.addEventListener("close", (event) => {
    if (!stopped && event.code !== 1000 && event.code !== 1005) {
      const reason = event.reason ? `: ${event.reason}` : "";
      callbacks.onError(
        new Error(
          `${hooks.label} WebSocket closed (code ${event.code}${reason})`,
        ),
      );
    }
    stopped = true;
    rec.stop();
    emitClose();
  });

  if (VOICE_DEBUG) {
    process.stderr.write(
      `[voiceInput] driver=${hooks.label} recorder=${recorder.command} ${recorder.args.join(" ")}\n`,
    );
  }

  /**
   * Stops the recorder and closes the WebSocket.
   *
   * **Note on asynchronicity:** This function is `async` only to satisfy the
   * {@link VoiceSession} interface. It is called without `await` from event
   * listeners (recorder exit, WebSocket error/close). Callers must not rely
   * on the returned promise because unhandled rejections would crash the
   * process. If the function is ever changed to perform real async work,
   * every call site must wrap it with `.catch(() => {})`.
   */
  async function stop() {
    if (stopped) return;
    stopped = true;
    rec.stop();
    pendingAudio.length = 0;
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      try {
        ws.close(1000, "client stop");
      } catch (err) {
        if (VOICE_DEBUG) {
          process.stderr.write(
            `[voiceInput] ws.close failed: ${formatError(err)}\n`,
          );
        }
      }
    }
    emitClose();
  }

  return { stop };
}

/**
 * Drop whitespace sitting between two CJK characters. Some providers return
 * Japanese transcripts with morpheme-separating spaces ("そう 、 声 で");
 * mixed strings like "Windows を使う" keep their inter-script spaces.
 *
 * @returns {{ push: (text: string) => string, flush: () => string }}
 */
export function createCJKSpaceNormalizer() {
  let prevChar = "";
  let pendingSpaces = "";

  /**
   * @param {string} c
   * @returns {boolean}
   */
  function isSpace(c) {
    return c === " " || c === "\t" || c === "\u3000";
  }

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
 * @param {string} ch
 * @returns {boolean}
 */
function isCJKChar(ch) {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x3000 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2ffff)
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err);
}
