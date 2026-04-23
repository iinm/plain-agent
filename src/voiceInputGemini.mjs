import {
  createCJKSpaceNormalizer,
  detectRecorder,
  failVoiceSessionAsync,
  getRecorderCandidates,
  isCommandAvailable,
  isObjectLike,
  startRecorder,
  VOICE_DEBUG,
} from "./voiceInputCommon.mjs";

/**
 * @import { VoiceRecorderConfig, VoiceSession, VoiceSessionCallbacks } from "./voiceInputCommon.mjs"
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

const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";
const GEMINI_DEFAULT_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GEMINI_SAMPLE_RATE = 16000;
const GEMINI_LABEL = "Gemini Live";

/**
 * Start a voice input session backed by the Gemini Live BidiGenerateContent
 * WebSocket. Spawns a recorder, streams PCM as base64 JSON messages, and
 * forwards transcript deltas via `onTranscript`.
 *
 * Gemini Live was designed for voice agents, not pure STT, so the setup
 * message forces `maxOutputTokens: 1` and disables thinking on 2.5 models
 * to minimise wasted audio output.
 *
 * @param {object} options
 * @param {VoiceInputGeminiConfig} options.config
 * @param {VoiceSessionCallbacks} options.callbacks
 * @returns {VoiceSession}
 */
export function startGeminiVoiceSession({ config, callbacks }) {
  const recorder =
    config.recorder ??
    detectRecorder(getRecorderCandidates(GEMINI_SAMPLE_RATE));
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

  const model = config.model ?? GEMINI_DEFAULT_MODEL;
  const base = config.baseURL ?? GEMINI_DEFAULT_WS;

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

  const ws = new WebSocket(`${base}?key=${encodeURIComponent(config.apiKey)}`);
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
      realtimeInput: {
        audio: {
          data: chunk.toString("base64"),
          mimeType: `audio/pcm;rate=${GEMINI_SAMPLE_RATE}`,
        },
      },
    };
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // connection may have just closed
    }
  }

  ws.addEventListener("open", () => {
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
      model: `models/${model}`,
      generationConfig,
      inputAudioTranscription: {},
    };
    if (config.language) {
      setup.systemInstruction = {
        parts: [{ text: `The user is speaking in ${config.language}.` }],
      };
    }
    try {
      ws.send(JSON.stringify({ setup }));
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

    if (!ready && "setupComplete" in message) {
      ready = true;
      for (const chunk of pendingAudio.splice(0)) {
        if (ws.readyState === WebSocket.OPEN) sendAudio(chunk);
      }
      return;
    }

    const serverContent = message.serverContent;
    if (!isObjectLike(serverContent)) return;
    const transcription = serverContent.inputTranscription;
    if (
      isObjectLike(transcription) &&
      typeof transcription.text === "string" &&
      transcription.text.length > 0
    ) {
      const normalized = normalizer.push(transcription.text);
      if (normalized.length > 0) {
        callbacks.onTranscript(normalized);
      }
    }
  });

  ws.addEventListener("error", (event) => {
    if (stopped) return;
    const message =
      /** @type {{ message?: string }} */ (event).message ?? "WebSocket error";
    callbacks.onError(new Error(`${GEMINI_LABEL} WebSocket error: ${message}`));
    stop();
  });

  ws.addEventListener("close", (event) => {
    if (!stopped && event.code !== 1000 && event.code !== 1005) {
      const reason = event.reason ? `: ${event.reason}` : "";
      callbacks.onError(
        new Error(
          `${GEMINI_LABEL} WebSocket closed (code ${event.code}${reason})`,
        ),
      );
    }
    stopped = true;
    rec.stop();
    emitClose();
  });

  if (VOICE_DEBUG) {
    process.stderr.write(
      `[voiceInput] driver=${GEMINI_LABEL} recorder=${recorder.command} ${recorder.args.join(" ")}\n`,
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
