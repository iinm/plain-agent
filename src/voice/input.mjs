import { startGeminiVoiceSession } from "./inputGemini.mjs";
import { startOpenAIVoiceSession } from "./inputOpenAI.mjs";
import { failVoiceSessionAsync } from "./inputSession.mjs";

export {
  createCJKSpaceNormalizer,
  detectRecorder,
  getRecorderCandidates,
} from "./inputSession.mjs";
export { parseVoiceToggleKey } from "./toggleKey.mjs";

/**
 * @typedef {import("./inputSession.mjs").VoiceRecorderConfig} VoiceRecorderConfig
 */

/**
 * @typedef {import("./inputSession.mjs").VoiceSessionCallbacks} VoiceSessionCallbacks
 */

/**
 * @typedef {import("./inputSession.mjs").VoiceSession} VoiceSession
 */

/**
 * @typedef {import("./toggleKey.mjs").VoiceToggleKey} VoiceToggleKey
 */

/**
 * @typedef {import("./inputOpenAI.mjs").VoiceInputOpenAIConfig} VoiceInputOpenAIConfig
 */

/**
 * @typedef {import("./inputGemini.mjs").VoiceInputGeminiConfig} VoiceInputGeminiConfig
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
