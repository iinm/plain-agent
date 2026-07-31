import { callAnthropicModel } from "./providers/anthropic.mjs";
import { callBedrockConverseModel } from "./providers/bedrock.mjs";
import { createCacheEnabledGeminiModelCaller } from "./providers/gemini.mjs";
import { callOpenAIChatCompletionsModel } from "./providers/openaiChatCompletions.mjs";
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
    case "openai-chat-completions":
      return (input) =>
        callOpenAIChatCompletionsModel(platform, model.config, input);
    case "bedrock-converse":
      return (input) => callBedrockConverseModel(platform, model.config, input);
  }
}
