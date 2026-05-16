import { startGeminiVoiceSession } from "./gemini.mjs";
import { startOpenAIVoiceSession } from "./openai.mjs";
import { failVoiceSessionAsync } from "./session.mjs";

/**
 * @typedef {import("./openai.mjs").VoiceInputOpenAIConfig | import("./gemini.mjs").VoiceInputGeminiConfig} VoiceInputConfig
 */
/**
 * Start a voice input session. Dispatches to the provider-specific
 * implementation based on `config.provider`.
 *
 * @param {object} options
 * @param {VoiceInputConfig} options.config
 * @param {import("./session.mjs").VoiceSessionCallbacks} options.callbacks
 * @returns {import("./session.mjs").VoiceSession}
 */
export function startVoiceSession({ config, callbacks }) {
  if (config.provider === "openai") {
    return startOpenAIVoiceSession({ config, callbacks });
  }
  if (config.provider === "gemini") {
    return startGeminiVoiceSession({ config, callbacks });
  }
  const provider = /** @type {{ provider: string }} */ (config).provider;
  return failVoiceSessionAsync(
    callbacks,
    new Error(`Unsupported voiceInput.provider: ${provider}`),
  );
}
