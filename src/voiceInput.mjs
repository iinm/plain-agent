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
 * @typedef {Object} VoiceInputOpenAIConfig
 * @property {"openai"} provider
 * @property {string} apiKey
 * @property {string} [model] - Defaults to "gpt-4o-transcribe".
 * @property {string} [baseURL]
 * @property {VoiceRecorderConfig} [recorder]
 * @property {string} [toggleKey] - "ctrl-<char>". Defaults to "ctrl-o".
 */

/**
 * @typedef {Object} VoiceInputGeminiConfig
 * @property {"gemini"} provider
 * @property {string} apiKey
 * @property {string} [model] - Defaults to "gemini-3.1-flash-live-preview".
 * @property {string} [baseURL]
 * @property {VoiceRecorderConfig} [recorder]
 * @property {string} [toggleKey]
 */

/**
 * @typedef {VoiceInputOpenAIConfig | VoiceInputGeminiConfig} VoiceInputConfig
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

const OPENAI_DEFAULT_MODEL = "gpt-4o-transcribe";
const OPENAI_DEFAULT_WS = "wss://api.openai.com/v1/realtime";
const OPENAI_SAMPLE_RATE = 24000;

const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const GEMINI_DEFAULT_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GEMINI_SAMPLE_RATE = 16000;

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isCJKChar(ch) {
  if (!ch) return false;
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
 * Drop whitespace sitting between two CJK characters. Some providers return
 * Japanese transcripts with morpheme-separating spaces ("そう 、 声 で");
 * mixed strings like "Windows を使う" keep their inter-script spaces.
 *
 * @returns {{ push: (text: string) => string, flush: () => string }}
 */
export function createCJKSpaceNormalizer() {
  let prevChar = "";
  let pendingSpaces = "";
  const isSpace = (/** @type {string} */ c) =>
    c === " " || c === "\t" || c === "\u3000";

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
 * @typedef {Object} VoiceToggleKey
 * @property {number} byte
 * @property {string} label
 */

/**
 * Parse a "ctrl-<char>" binding into the raw byte the terminal sends in
 * raw mode. Only Ctrl-<char> is supported because it is the only family
 * the pre-readline pipeline can recognize without a full key decoder.
 *
 * @param {string | undefined} spec
 * @returns {VoiceToggleKey}
 */
export function parseVoiceToggleKey(spec) {
  const raw = (spec ?? "ctrl-o").trim().toLowerCase();
  const match = /^ctrl-(.)$/.exec(raw);
  if (!match) {
    throw new Error(
      `Invalid voiceInput.toggleKey "${spec}". Expected "ctrl-<char>".`,
    );
  }
  const ch = match[1];
  const code = ch.charCodeAt(0);
  let byte;
  if (code >= 0x61 && code <= 0x7a) {
    byte = code - 0x60;
  } else if (code >= 0x5b && code <= 0x5f) {
    byte = code - 0x40;
  } else {
    throw new Error(
      `Unsupported voiceInput.toggleKey "${spec}". Use ctrl-<letter> or ctrl-<[ \\ ] ^ _>.`,
    );
  }
  const reserved = new Set([0x03, 0x04, 0x09, 0x0a, 0x0d, 0x11, 0x13]);
  if (reserved.has(byte)) {
    throw new Error(
      `voiceInput.toggleKey "${spec}" conflicts with a reserved terminal/readline key.`,
    );
  }
  return { byte, label: `Ctrl-${ch.toUpperCase()}` };
}

/**
 * @param {number} sampleRate
 * @returns {VoiceRecorderConfig[]}
 */
export function getRecorderCandidates(sampleRate = OPENAI_SAMPLE_RATE) {
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
 * @param {string} command
 */
function isCommandAvailable(command) {
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
 * @typedef {Object} VoiceDriver
 * @property {string} label
 * @property {number} sampleRate
 * @property {() => WebSocket} connect
 * @property {() => object} buildSetup
 * @property {(message: Record<string, unknown>) => boolean} isReady
 * @property {(base64: string) => object} buildAudioMessage
 * @property {(message: Record<string, unknown>) => string | null} parseTranscript
 */

/**
 * @param {VoiceInputConfig} config
 * @returns {VoiceDriver}
 */
function createDriver(config) {
  if (config.provider === "openai") {
    return createOpenAIDriver(config);
  }
  if (config.provider === "gemini") {
    return createGeminiDriver(config);
  }
  throw new Error(
    `Unsupported voiceInput.provider: ${/** @type {{provider: string}} */ (config).provider}`,
  );
}

/**
 * @param {VoiceInputOpenAIConfig} config
 * @returns {VoiceDriver}
 */
function createOpenAIDriver(config) {
  const model = config.model ?? OPENAI_DEFAULT_MODEL;
  const base = config.baseURL ?? OPENAI_DEFAULT_WS;
  return {
    label: "OpenAI Realtime",
    sampleRate: OPENAI_SAMPLE_RATE,
    connect() {
      // Node's global WebSocket (undici) accepts a non-standard `headers`
      // option. The built-in typings only declare the standards-compliant
      // constructor, so cast through `WebSocket`-as-constructor.
      const Ctor =
        /** @type {new (url: string, opts?: unknown) => WebSocket} */ (
          /** @type {unknown} */ (WebSocket)
        );
      return new Ctor(`${base}?intent=transcription`, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });
    },
    buildSetup() {
      return {
        type: "session.update",
        session: {
          audio: {
            input: {
              format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
              transcription: { model },
              turn_detection: { type: "server_vad" },
            },
          },
        },
      };
    },
    isReady(message) {
      return (
        message.type === "session.updated" || message.type === "session.created"
      );
    },
    buildAudioMessage(base64) {
      return { type: "input_audio_buffer.append", audio: base64 };
    },
    parseTranscript(message) {
      if (
        message.type === "conversation.item.input_audio_transcription.delta" &&
        typeof message.delta === "string" &&
        message.delta.length > 0
      ) {
        return message.delta;
      }
      return null;
    },
  };
}

/**
 * @param {VoiceInputGeminiConfig} config
 * @returns {VoiceDriver}
 */
function createGeminiDriver(config) {
  const model = config.model ?? GEMINI_DEFAULT_MODEL;
  const base = config.baseURL ?? GEMINI_DEFAULT_WS;
  return {
    label: "Gemini Live",
    sampleRate: GEMINI_SAMPLE_RATE,
    connect() {
      return new WebSocket(`${base}?key=${encodeURIComponent(config.apiKey)}`);
    },
    buildSetup() {
      // responseModalities is AUDIO not TEXT: the 3.1 preview model returns
      // a 1011 internal error for TEXT-only output
      // (https://github.com/googleapis/python-genai/issues/2238). We discard
      // the audio response; `inputAudioTranscription` is emitted regardless.
      return {
        setup: {
          model: `models/${model}`,
          generationConfig: { responseModalities: ["AUDIO"] },
          inputAudioTranscription: {},
        },
      };
    },
    isReady(message) {
      return "setupComplete" in message;
    },
    buildAudioMessage(base64) {
      return {
        realtimeInput: {
          audio: {
            data: base64,
            mimeType: `audio/pcm;rate=${GEMINI_SAMPLE_RATE}`,
          },
        },
      };
    },
    parseTranscript(message) {
      const serverContent = message.serverContent;
      if (!isObject(serverContent)) return null;
      const t = serverContent.inputTranscription;
      if (isObject(t) && typeof t.text === "string" && t.text.length > 0) {
        return t.text;
      }
      return null;
    },
  };
}

/**
 * Start a voice input session. Spawns a recorder, opens a WebSocket to the
 * configured provider, and streams transcript deltas via `onTranscript`.
 *
 * @param {object} options
 * @param {VoiceInputConfig} options.config
 * @param {VoiceSessionCallbacks} options.callbacks
 * @returns {VoiceSession}
 */
export function startVoiceSession({ config, callbacks }) {
  /** @type {VoiceDriver} */
  let driver;
  try {
    driver = createDriver(config);
  } catch (err) {
    queueMicrotask(() => {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      callbacks.onClose?.();
    });
    return { stop: async () => {} };
  }

  const recorder =
    config.recorder ?? detectRecorder(getRecorderCandidates(driver.sampleRate));
  if (!recorder) {
    queueMicrotask(() => {
      callbacks.onError(
        new Error(
          "No voice recorder found. Install arecord, sox, or ffmpeg (or set `voiceInput.recorder`).",
        ),
      );
      callbacks.onClose?.();
    });
    return { stop: async () => {} };
  }

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

  let stopped = false;
  let closeEmitted = false;
  let ready = false;
  /** @type {Buffer[]} */
  const pendingAudio = [];
  const normalizer = createCJKSpaceNormalizer();

  const emitClose = () => {
    if (closeEmitted) return;
    closeEmitted = true;
    callbacks.onClose?.();
  };

  const ws = driver.connect();
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
    if (ready && ws.readyState === WebSocket.OPEN) {
      sendAudio(chunk);
    } else {
      pendingAudio.push(chunk);
    }
  });

  ws.addEventListener("open", () => {
    try {
      ws.send(JSON.stringify(driver.buildSetup()));
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
    if (!isObject(message)) return;

    if (!ready && driver.isReady(message)) {
      ready = true;
      while (pendingAudio.length > 0) {
        const chunk = pendingAudio.shift();
        if (chunk && ws.readyState === WebSocket.OPEN) {
          sendAudio(chunk);
        }
      }
      return;
    }

    const text = driver.parseTranscript(message);
    if (text !== null) {
      const normalized = normalizer.push(text);
      if (normalized.length > 0) {
        callbacks.onTranscript(normalized);
      }
    }
  });

  ws.addEventListener("error", (event) => {
    if (stopped) return;
    const message =
      /** @type {{ message?: string }} */ (event).message ?? "WebSocket error";
    callbacks.onError(new Error(`${driver.label} WebSocket error: ${message}`));
    stop();
  });

  ws.addEventListener("close", (event) => {
    if (!stopped && event.code !== 1000 && event.code !== 1005) {
      const reason = event.reason ? `: ${event.reason}` : "";
      callbacks.onError(
        new Error(
          `${driver.label} WebSocket closed (code ${event.code}${reason})`,
        ),
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
   * @param {Buffer} chunk
   */
  function sendAudio(chunk) {
    const payload = driver.buildAudioMessage(chunk.toString("base64"));
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // connection may have just closed
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async function stop() {
    if (stopped) return;
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
