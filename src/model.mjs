import { callAnthropicModel } from "./providers/anthropic.mjs";
import { callBedrockConverseModel } from "./providers/bedrock.mjs";
import { createCacheEnabledGeminiModelCaller } from "./providers/gemini.mjs";
import { callOpenAIMessagesModel } from "./providers/openaiMessages.mjs";
import { callOpenAIResponsesModel } from "./providers/openaiResponses.mjs";

/**
 * @param {import("./model.definition").ModelDefinition} modelDef
 * @returns {import("./model").CallModel}
 */
export function createModelCaller(modelDef) {
  const { platform, model } = modelDef;

  switch (model.format) {
    case "anthropic":
      return (input) => callAnthropicModel(platform, model.config, input);
    case "gemini": {
      const modelCaller = createCacheEnabledGeminiModelCaller(
        platform,
        model.config,
      );
      return (input) => modelCaller(model.config, input);
    }
    case "openai-responses":
      return (input) => callOpenAIResponsesModel(platform, model.config, input);
    case "openai-messages":
      return (input) => callOpenAIMessagesModel(platform, model.config, input);
    case "bedrock-converse":
      return (input) => callBedrockConverseModel(platform, model.config, input);
  }
}
