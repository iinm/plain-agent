import { failVoiceSessionAsync } from "./voiceInputCommon.mjs";
import { startGeminiVoiceSession } from "./voiceInputGemini.mjs";
import { startOpenAIVoiceSession } from "./voiceInputOpenAI.mjs";

export {
  createCJKSpaceNormalizer,
  detectRecorder,
  getRecorderCandidates,
  parseVoiceToggleKey,
} from "./voiceInputCommon.mjs";

/**
 * @typedef {import("./voiceInputCommon.mjs").VoiceRecorderConfig} VoiceRecorderConfig
 */

/**
 * @typedef {import("./voiceInputCommon.mjs").VoiceSessionCallbacks} VoiceSessionCallbacks
 */

/**
 * @typedef {import("./voiceInputCommon.mjs").VoiceSession} VoiceSession
 */

/**
 * @typedef {import("./voiceInputCommon.mjs").VoiceToggleKey} VoiceToggleKey
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
