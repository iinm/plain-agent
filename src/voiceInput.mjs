import { spawn, spawnSync } from "node:child_process";
import { getGoogleCloudAccessToken } from "./providers/platform/googleCloud.mjs";

/**
 * @typedef {VoiceInputOpenAIConfig | VoiceInputGeminiConfig | VoiceInputGeminiVertexAIConfig} VoiceInputConfig
 */

/**
 * @typedef {Object} VoiceInputOpenAIConfig
 * @property {"openai"} provider
 * @property {string} apiKey
 * @property {string} [model] - Defaults to "gpt-4o-transcribe".
 * @property {string} [language] - ISO-639-1 code (e.g. "ja", "en"). Improves accuracy and latency when set.
 * @property {string} [baseURL]
 * @property {VoiceRecorderConfig} [recorder]
 * @property {string} [toggleKey] - "ctrl-<char>". Defaults to "ctrl-o".
 */

/**
 * @typedef {Object} VoiceInputGeminiConfig
 * @property {"gemini"} provider
 * @property {string} apiKey
 * @property {string} [model] - Defaults to "gemini-3.1-flash-live-preview".
 * @property {string} [language] - ISO-639-1 code (e.g. "ja", "en"). Passed to the model as a system instruction since Gemini Live has no native language hint for input transcription.
 * @property {string} [baseURL]
 * @property {VoiceRecorderConfig} [recorder]
 * @property {string} [toggleKey]
 */

/**
 * @typedef {Object} VoiceInputGeminiVertexAIConfig
 * @property {"gemini-vertex-ai"} provider
 * @property {string} baseURL - Vertex AI REST base, e.g. `https://aiplatform.googleapis.com/v1beta1/projects/<project>/locations/<location>`. Used to derive the Live API WebSocket endpoint and model resource path.
 * @property {string} [account] - Optional gcloud account or service account email passed to `gcloud auth print-access-token`.
 * @property {string} [model] - Defaults to "gemini-3.1-flash-live-preview".
 * @property {string} [language]
 * @property {VoiceRecorderConfig} [recorder]
 * @property {string} [toggleKey]
 */

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

const DEBUG = process.env.PLAIN_VOICE_DEBUG === "1";

// Bytes reserved for other terminal/readline uses — cannot be used as a voice toggle.
//   0x03 = Ctrl-C (SIGINT)
//   0x04 = Ctrl-D (EOF / readline exit)
//   0x09 = Ctrl-I (Tab)
//   0x0a = Ctrl-J (LF / Enter)
//   0x0d = Ctrl-M (CR / Enter)
//   0x11 = Ctrl-Q (XON: resume terminal output)
//   0x13 = Ctrl-S (XOFF: suspend terminal output)
const RESERVED_TERMINAL_BYTES = new Set([
  0x03, 0x04, 0x09, 0x0a, 0x0d, 0x11, 0x13,
]);

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

  // Subtracting a fixed offset from the character's ASCII code yields the
  // control byte (0x01–0x1f) the terminal sends for that Ctrl combination.
  let byte;
  if (code >= 0x61 && code <= 0x7a) {
    // a–z (0x61–0x7a): subtract 0x60 → 0x01 (Ctrl-A) – 0x1a (Ctrl-Z)
    byte = code - 0x60;
  } else if (code >= 0x5b && code <= 0x5f) {
    // [ \ ] ^ _ (0x5b–0x5f): subtract 0x40 → 0x1b (Ctrl-[) – 0x1f (Ctrl-_)
    byte = code - 0x40;
  } else {
    throw new Error(
      `Unsupported voiceInput.toggleKey "${spec}". Use ctrl-<letter> or ctrl-<[ \\ ] ^ _>.`,
    );
  }

  if (RESERVED_TERMINAL_BYTES.has(byte)) {
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
 * Start a voice input session. Spawns a recorder, opens a WebSocket to the
 * configured provider, and streams transcript deltas via `onTranscript`.
 *
 * @param {object} options
 * @param {VoiceInputConfig} options.config
 * @param {VoiceSessionCallbacks} options.callbacks
 * @returns {VoiceSession}
 */
export function startVoiceSession({ config, callbacks }) {
  /**
   * Report an error asynchronously and return an already-terminated session.
   * @param {Error} error
   * @returns {VoiceSession}
   */
  function failAsync(error) {
    queueMicrotask(() => {
      callbacks.onError(error);
      callbacks.onClose?.();
    });
    return { stop: async () => {} };
  }

  /** @type {VoiceDriver} */
  let driver;
  try {
    driver = createDriver(config);
  } catch (err) {
    return failAsync(err instanceof Error ? err : new Error(String(err)));
  }

  const recorder =
    config.recorder ?? detectRecorder(getRecorderCandidates(driver.sampleRate));
  if (!recorder) {
    return failAsync(
      new Error(
        "No voice recorder found. Install arecord, sox, or ffmpeg (or set `voiceInput.recorder`).",
      ),
    );
  }

  if (!isCommandAvailable(recorder.command)) {
    return failAsync(
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
  /** @type {WebSocket | null} */
  let ws = null;

  const emitClose = () => {
    if (closeEmitted) return;
    closeEmitted = true;
    callbacks.onClose?.();
  };

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
    if (ready && ws !== null && ws.readyState === WebSocket.OPEN) {
      sendAudio(ws, chunk);
    } else {
      pendingAudio.push(chunk);
    }
  });

  (async () => {
    let connected;
    try {
      connected = await driver.connect();
    } catch (err) {
      if (stopped) return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      stop();
      return;
    }
    if (stopped) {
      try {
        connected.close(1000, "client stop");
      } catch {
        // ignore
      }
      return;
    }

    ws = connected;
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      if (stopped || ws === null) return;
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
      if (stopped || ws === null) return;
      let message;
      let raw = "";
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
          new Error(
            `Failed to parse server message: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      if (!isObject(message)) return;
      if (DEBUG) {
        process.stderr.write(`[voiceInput] <- ${raw.slice(0, 800)}\n`);
      }

      if (message.type === "error" && isObject(message.error)) {
        const detail =
          typeof message.error.message === "string"
            ? message.error.message
            : JSON.stringify(message.error);
        callbacks.onError(new Error(`${driver.label} error: ${detail}`));
        return;
      }

      if (!ready && driver.isReady(message)) {
        ready = true;
        for (const chunk of pendingAudio.splice(0)) {
          if (ws.readyState === WebSocket.OPEN) sendAudio(ws, chunk);
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
        /** @type {{ message?: string }} */ (event).message ??
        "WebSocket error";
      callbacks.onError(
        new Error(`${driver.label} WebSocket error: ${message}`),
      );
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
  })();

  /**
   * @param {WebSocket} socket
   * @param {Buffer} chunk
   */
  function sendAudio(socket, chunk) {
    const payload = driver.buildAudioMessage(chunk.toString("base64"));
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // connection may have just closed
    }
  }

  if (DEBUG) {
    process.stderr.write(
      `[voiceInput] driver=${driver.label} recorder=${recorder.command} ${recorder.args.join(" ")}\n`,
    );
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
      ws !== null &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
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
 * @typedef {Object} VoiceDriver
 * @property {string} label
 * @property {number} sampleRate
 * @property {() => WebSocket | Promise<WebSocket>} connect
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
  if (config.provider === "gemini-vertex-ai") {
    return createGeminiVertexAIDriver(config);
  }
  throw new Error(
    `Unsupported voiceInput.provider: ${/** @type {{provider: string}} */ (config).provider}`,
  );
}

const OPENAI_DEFAULT_MODEL = "gpt-4o-transcribe";
const OPENAI_DEFAULT_WS = "wss://api.openai.com/v1/realtime";
const OPENAI_SAMPLE_RATE = 24000;

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
      /** @type {{ model: string, language?: string }} */
      const transcription = { model };
      if (config.language) transcription.language = config.language;
      // The `?intent=transcription` endpoint uses the flat transcription-session
      // schema, not the nested `session.audio.input.*` realtime schema.
      return {
        type: "transcription_session.update",
        session: {
          input_audio_format: "pcm16",
          input_audio_transcription: transcription,
          turn_detection: { type: "server_vad" },
        },
      };
    },
    isReady(message) {
      return (
        message.type === "transcription_session.created" ||
        message.type === "transcription_session.updated"
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

const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const GEMINI_DEFAULT_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GEMINI_SAMPLE_RATE = 16000;

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
      return buildGeminiLiveSetup({
        model,
        modelPath: `models/${model}`,
        language: config.language,
      });
    },
    isReady: isGeminiLiveReady,
    buildAudioMessage: buildGeminiLiveAudioMessage,
    parseTranscript: parseGeminiLiveTranscript,
  };
}

/**
 * Parse a Vertex AI REST base URL into its components, e.g.
 * `https://aiplatform.googleapis.com/v1beta1/projects/<project>/locations/<location>`
 * → { host, version, project, location }.
 *
 * @param {string} baseURL
 */
function parseVertexAIBaseURL(baseURL) {
  const match =
    /^https?:\/\/([^/]+)\/(v[0-9][^/]*)\/projects\/([^/]+)\/locations\/([^/]+)\/?$/.exec(
      baseURL,
    );
  if (!match) {
    throw new Error(
      `voiceInput: invalid gemini-vertex-ai baseURL "${baseURL}". Expected ".../v1beta1/projects/<project>/locations/<location>".`,
    );
  }
  const [, host, version, project, location] = match;
  return { host, version, project, location };
}

/**
 * @param {VoiceInputGeminiVertexAIConfig} config
 * @returns {VoiceDriver}
 */
function createGeminiVertexAIDriver(config) {
  const model = config.model ?? GEMINI_DEFAULT_MODEL;
  const { host, version, project, location } = parseVertexAIBaseURL(
    config.baseURL,
  );
  // Prefer the location-specific host when the caller passed the generic
  // global host, matching the Python `google-genai` SDK's behaviour.
  const wsHost =
    host === "aiplatform.googleapis.com"
      ? `${location}-aiplatform.googleapis.com`
      : host;
  const wsUrl = `wss://${wsHost}/ws/google.cloud.aiplatform.${version}.LlmBidiService/BidiGenerateContent`;
  const modelPath = `projects/${project}/locations/${location}/publishers/google/models/${model}`;

  return {
    label: "Gemini Live (Vertex AI)",
    sampleRate: GEMINI_SAMPLE_RATE,
    async connect() {
      const token = await getGoogleCloudAccessToken(config.account);
      // Node's global WebSocket (undici) accepts a non-standard `headers`
      // option. The built-in typings only declare the standards-compliant
      // constructor, so cast through `WebSocket`-as-constructor.
      const Ctor =
        /** @type {new (url: string, opts?: unknown) => WebSocket} */ (
          /** @type {unknown} */ (WebSocket)
        );
      return new Ctor(wsUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    },
    buildSetup() {
      return buildGeminiLiveSetup({
        model,
        modelPath,
        language: config.language,
      });
    },
    isReady: isGeminiLiveReady,
    buildAudioMessage: buildGeminiLiveAudioMessage,
    parseTranscript: parseGeminiLiveTranscript,
  };
}

/**
 * Gemini Live was designed for voice agents, not pure STT. Force
 * `maxOutputTokens: 1` and disable thinking on 2.5 models to minimise
 * wasted audio output.
 *
 * @param {{ model: string, modelPath: string, language?: string }} params
 */
function buildGeminiLiveSetup({ model, modelPath, language }) {
  /** @type {Record<string, unknown>} */
  const generationConfig = {
    // https://ai.google.dev/gemini-api/docs/live-api/capabilities#response-modalities
    // > The native audio models only support `AUDIO` response modality.
    responseModalities: ["AUDIO"],
    maxOutputTokens: 1,
  };
  if (model.includes("2.5")) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  /** @type {Record<string, unknown>} */
  const setup = {
    model: modelPath,
    generationConfig,
    inputAudioTranscription: {},
  };
  if (language) {
    setup.systemInstruction = {
      parts: [{ text: `The user is speaking in ${language}.` }],
    };
  }
  return { setup };
}

/**
 * @param {Record<string, unknown>} message
 */
function isGeminiLiveReady(message) {
  return "setupComplete" in message;
}

/**
 * @param {string} base64
 */
function buildGeminiLiveAudioMessage(base64) {
  return {
    realtimeInput: {
      audio: {
        data: base64,
        mimeType: `audio/pcm;rate=${GEMINI_SAMPLE_RATE}`,
      },
    },
  };
}

/**
 * @param {Record<string, unknown>} message
 * @returns {string | null}
 */
function parseGeminiLiveTranscript(message) {
  const serverContent = message.serverContent;
  if (!isObject(serverContent)) return null;
  const t = serverContent.inputTranscription;
  if (isObject(t) && typeof t.text === "string" && t.text.length > 0) {
    return t.text;
  }
  return null;
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
function isObject(value) {
  return typeof value === "object" && value !== null;
}
