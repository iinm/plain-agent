import { callAnthropicModel } from "./providers/anthropic.mjs";
import { callBedrockConverseModel } from "./providers/bedrock.mjs";
import { createCacheEnabledGeminiModelCaller } from "./providers/gemini.mjs";
import { callOpenAIModel } from "./providers/openai.mjs";
import { callOpenAICompatibleModel } from "./providers/openaiCompatible.mjs";

/**
 * @param {import("./modelDefinition").ModelDefinition} modelDef
 * @returns {import("./model").CallModel}
 */
export function createModelCaller(modelDef) {
  const { platform, format, config } = modelDef;

  switch (format) {
    case "anthropic":
      return (input) => callAnthropicModel(platform, config, input);
    case "gemini": {
      const modelCaller = createCacheEnabledGeminiModelCaller(platform, config);
      return (input) => modelCaller(config, input);
    }
    case "openai-responses":
      return (input) => callOpenAIModel(platform, config, input);
    case "openai-messages":
      return (input) => callOpenAICompatibleModel(platform, config, input);
    case "bedrock-converse":
      return (input) => callBedrockConverseModel(platform, config, input);
  }
}
