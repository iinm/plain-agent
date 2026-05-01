/**
 * @param {import("./modelDefinition").ModelDefinition} modelDef
 * @returns {Promise<import("./model").CallModel>}
 */
export async function createModelCaller(modelDef) {
  const { platform, model } = modelDef;

  switch (model.format) {
    case "anthropic": {
      const { callAnthropicModel } = await import("./providers/anthropic.mjs");
      return (input) => callAnthropicModel(platform, model.config, input);
    }
    case "gemini": {
      const { createCacheEnabledGeminiModelCaller } = await import(
        "./providers/gemini.mjs"
      );
      const modelCaller = createCacheEnabledGeminiModelCaller(
        platform,
        model.config,
      );
      return (input) => modelCaller(model.config, input);
    }
    case "openai-responses": {
      const { callOpenAIModel } = await import("./providers/openai.mjs");
      return (input) => callOpenAIModel(platform, model.config, input);
    }
    case "openai-messages": {
      const { callOpenAICompatibleModel } = await import(
        "./providers/openaiCompatible.mjs"
      );
      return (input) =>
        callOpenAICompatibleModel(platform, model.config, input);
    }
    case "bedrock-converse": {
      const { callBedrockConverseModel } = await import(
        "./providers/bedrock.mjs"
      );
      return (input) => callBedrockConverseModel(platform, model.config, input);
    }
  }
}
