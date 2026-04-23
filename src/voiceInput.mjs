import { startGeminiVoiceSession } from "./voiceInputGemini.mjs";
import { startOpenAIVoiceSession } from "./voiceInputOpenAI.mjs";
import { failVoiceSessionAsync } from "./voiceInputSession.mjs";

export {
  createCJKSpaceNormalizer,
  detectRecorder,
  getRecorderCandidates,
} from "./voiceInputSession.mjs";
export { parseVoiceToggleKey } from "./voiceToggleKey.mjs";

/**
 * @typedef {import("./voiceInputSession.mjs").VoiceRecorderConfig} VoiceRecorderConfig
 */

/**
 * @typedef {import("./voiceInputSession.mjs").VoiceSessionCallbacks} VoiceSessionCallbacks
 */

/**
 * @typedef {import("./voiceInputSession.mjs").VoiceSession} VoiceSession
 */

/**
 * @typedef {import("./voiceToggleKey.mjs").VoiceToggleKey} VoiceToggleKey
 */

/**
 * @typedef {import("./voiceInputOpenAI.mjs").VoiceInputOpenAIConfig} VoiceInputOpenAIConfig
 */

/**
 * @typedef {import("./voiceInputGemini.mjs").VoiceInputGeminiConfig} VoiceInputGeminiConfig
 */

/**
 * @typedef {VoiceInputOpenAIConfig | VoiceInputGeminiConfig} VoiceInputConfig
 */

/**
 * Start a voice input session. Dispatches to the provider-specific
 * implementation based on `config.provider`.
 *
 * @param {object} options
 * @param {VoiceInputConfig} options.config
 * @param {VoiceSessionCallbacks} options.callbacks
 * @returns {VoiceSession}
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
