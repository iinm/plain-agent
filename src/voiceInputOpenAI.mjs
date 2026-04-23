import {
  createCJKSpaceNormalizer,
  detectRecorder,
  failVoiceSessionAsync,
  getRecorderCandidates,
  isCommandAvailable,
  isObjectLike,
  startRecorder,
  VOICE_DEBUG,
} from "./voiceInputSession.mjs";

/**
 * @import { VoiceRecorderConfig, VoiceSession, VoiceSessionCallbacks } from "./voiceInputSession.mjs"
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

const OPENAI_DEFAULT_MODEL = "gpt-4o-transcribe";
const OPENAI_DEFAULT_WS = "wss://api.openai.com/v1/realtime";
const OPENAI_SAMPLE_RATE = 24000;
const OPENAI_LABEL = "OpenAI Realtime";

/**
 * Start a voice input session backed by the OpenAI Realtime transcription
 * WebSocket. Spawns a recorder, streams PCM as base64 JSON messages, and
 * forwards transcript deltas via `onTranscript`.
 *
 * @param {object} options
 * @param {VoiceInputOpenAIConfig} options.config
 * @param {VoiceSessionCallbacks} options.callbacks
 * @returns {VoiceSession}
 */
export function startOpenAIVoiceSession({ config, callbacks }) {
  const recorder =
    config.recorder ??
    detectRecorder(getRecorderCandidates(OPENAI_SAMPLE_RATE));
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

  const model = config.model ?? OPENAI_DEFAULT_MODEL;
  const base = config.baseURL ?? OPENAI_DEFAULT_WS;

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

  // Node's global WebSocket (undici) accepts a non-standard `headers`
  // option. The built-in typings only declare the standards-compliant
  // constructor, so cast through `WebSocket`-as-constructor.
  const Ctor = /** @type {new (url: string, opts?: unknown) => WebSocket} */ (
    /** @type {unknown} */ (WebSocket)
  );
  const ws = new Ctor(`${base}?intent=transcription`, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
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
    const payload = {
      type: "input_audio_buffer.append",
      audio: chunk.toString("base64"),
    };
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // connection may have just closed
    }
  }

  ws.addEventListener("open", () => {
    /** @type {{ model: string, language?: string }} */
    const transcription = { model };
    if (config.language) transcription.language = config.language;
    // The `?intent=transcription` endpoint uses the flat transcription-session
    // schema, not the nested `session.audio.input.*` realtime schema.
    const setup = {
      type: "transcription_session.update",
      session: {
        input_audio_format: "pcm16",
        input_audio_transcription: transcription,
        turn_detection: { type: "server_vad" },
      },
    };
    try {
      ws.send(JSON.stringify(setup));
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
        new Error(
          `Failed to parse server message: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (!isObjectLike(message)) return;
    if (VOICE_DEBUG) {
      process.stderr.write(`[voiceInput] <- ${raw.slice(0, 800)}\n`);
    }

    if (message.type === "error" && isObjectLike(message.error)) {
      const detail =
        typeof message.error.message === "string"
          ? message.error.message
          : JSON.stringify(message.error);
      callbacks.onError(new Error(`${OPENAI_LABEL} error: ${detail}`));
      return;
    }

    if (
      !ready &&
      (message.type === "transcription_session.created" ||
        message.type === "transcription_session.updated")
    ) {
      ready = true;
      for (const chunk of pendingAudio.splice(0)) {
        if (ws.readyState === WebSocket.OPEN) sendAudio(chunk);
      }
      return;
    }

    if (
      message.type === "conversation.item.input_audio_transcription.delta" &&
      typeof message.delta === "string" &&
      message.delta.length > 0
    ) {
      const normalized = normalizer.push(message.delta);
      if (normalized.length > 0) {
        callbacks.onTranscript(normalized);
      }
    }
  });

  ws.addEventListener("error", (event) => {
    if (stopped) return;
    const message =
      /** @type {{ message?: string }} */ (event).message ?? "WebSocket error";
    callbacks.onError(new Error(`${OPENAI_LABEL} WebSocket error: ${message}`));
    stop();
  });

  ws.addEventListener("close", (event) => {
    if (!stopped && event.code !== 1000 && event.code !== 1005) {
      const reason = event.reason ? `: ${event.reason}` : "";
      callbacks.onError(
        new Error(
          `${OPENAI_LABEL} WebSocket closed (code ${event.code}${reason})`,
        ),
      );
    }
    stopped = true;
    rec.stop();
    emitClose();
  });

  if (VOICE_DEBUG) {
    process.stderr.write(
      `[voiceInput] driver=${OPENAI_LABEL} recorder=${recorder.command} ${recorder.args.join(" ")}\n`,
    );
  }

  /**
   * @returns {Promise<void>}
   */
  async function stop() {
    if (stopped) return;
    stopped = true;
    rec.stop();
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
