import {
  isObjectLike,
  startWebSocketVoiceSession,
} from "./voiceInputSession.mjs";

/**
 * @import { VoiceProviderHooks, VoiceRecorderConfig, VoiceSession, VoiceSessionCallbacks } from "./voiceInputSession.mjs"
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
  /** @type {VoiceProviderHooks<VoiceInputOpenAIConfig>} */
  const hooks = {
    label: OPENAI_LABEL,
    sampleRate: OPENAI_SAMPLE_RATE,
    buildWsUrl(config) {
      const base = config.baseURL ?? OPENAI_DEFAULT_WS;
      return `${base}?intent=transcription`;
    },
    buildWsOptions(config) {
      return {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      };
    },
    buildSetupMessage(config) {
      const model = config.model ?? OPENAI_DEFAULT_MODEL;
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
    isReadyMessage(message) {
      return (
        isObjectLike(message) &&
        (message.type === "transcription_session.created" ||
          message.type === "transcription_session.updated")
      );
    },
    extractError(message) {
      if (!isObjectLike(message) || message.type !== "error") return undefined;
      const error = message.error;
      if (!isObjectLike(error)) return undefined;
      return typeof error.message === "string"
        ? error.message
        : JSON.stringify(error);
    },
    extractTranscript(message) {
      if (
        isObjectLike(message) &&
        message.type === "conversation.item.input_audio_transcription.delta" &&
        typeof message.delta === "string" &&
        message.delta.length > 0
      ) {
        return message.delta;
      }
      return undefined;
    },
    buildAudioPayload(chunk, _sampleRate) {
      return {
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64"),
      };
    },
  };

  return startWebSocketVoiceSession({ hooks, config, callbacks });
}
