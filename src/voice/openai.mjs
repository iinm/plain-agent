import { isObjectLike, startWebSocketVoiceSession } from "./session.mjs";

/**
 * @import { VoiceProviderHooks, VoiceRecorderConfig, VoiceSession, VoiceSessionCallbacks } from "./session.mjs"
 */

/**
 * @typedef {Object} VoiceInputOpenAIConfig
 * @property {"openai"} provider
 * @property {string} apiKey
 * @property {string} [model] - Transcription model. Defaults to "gpt-realtime-whisper".
 * @property {string} [language] - ISO-639-1 code (e.g. "ja", "en"). Improves accuracy and latency when set.
 * @property {string} [baseURL]
 * @property {VoiceRecorderConfig} [recorder]
 * @property {string} [toggleKey] - "ctrl-<char>". Defaults to "ctrl-o".
 */

const OPENAI_DEFAULT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
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
        },
      };
    },
    buildSetupMessage(config) {
      const model = config.model ?? OPENAI_DEFAULT_TRANSCRIPTION_MODEL;
      /** @type {{ model: string, language?: string }} */
      const transcription = { model };
      if (config.language) transcription.language = config.language;
      return {
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
              transcription,
            },
          },
        },
      };
    },
    isReadyMessage(message) {
      return (
        isObjectLike(message) &&
        (message.type === "session.created" ||
          message.type === "session.updated")
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
