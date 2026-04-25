import {
  isObjectLike,
  startWebSocketVoiceSession,
} from "./voiceInputSession.mjs";

/**
 * @import { VoiceProviderHooks, VoiceRecorderConfig, VoiceSession, VoiceSessionCallbacks } from "./voiceInputSession.mjs"
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
  /** @type {VoiceProviderHooks<VoiceInputGeminiConfig>} */
  const hooks = {
    label: GEMINI_LABEL,
    sampleRate: GEMINI_SAMPLE_RATE,
    buildWsUrl(config) {
      const base = config.baseURL ?? GEMINI_DEFAULT_WS;
      return `${base}?key=${encodeURIComponent(config.apiKey)}`;
    },
    buildSetupMessage(config) {
      const model = config.model ?? GEMINI_DEFAULT_MODEL;
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
      return { setup };
    },
    isReadyMessage(message) {
      return isObjectLike(message) && "setupComplete" in message;
    },
    extractTranscript(message) {
      if (!isObjectLike(message)) return undefined;
      const serverContent = message.serverContent;
      if (!isObjectLike(serverContent)) return undefined;
      const transcription = serverContent.inputTranscription;
      if (
        isObjectLike(transcription) &&
        typeof transcription.text === "string" &&
        transcription.text.length > 0
      ) {
        return transcription.text;
      }
      return undefined;
    },
    buildAudioPayload(chunk, sampleRate) {
      return {
        realtimeInput: {
          audio: {
            data: chunk.toString("base64"),
            mimeType: `audio/pcm;rate=${sampleRate}`,
          },
        },
      };
    },
  };

  return startWebSocketVoiceSession({ hooks, config, callbacks });
}
