import { callAnthropicModel } from "../providers/anthropic.mjs";
import { createWebSearchTool } from "./webSearch.mjs";

const QUESTION = "明日の東京の天気を調べて";
/** @type {{ keywords: string[] }[]} */
const SEARCHES = [
  { keywords: ["東京", "天気", "明日"] },
  { keywords: ["Tokyo", "weather", "tomorrow"] },
];

const provider = process.argv[2] ?? "gemini";

/** @type {import("../providers/anthropic").AnthropicModelConfig} */
const modelConfig = {
  model: "claude-haiku-4-5",
  max_tokens: 8192,
};
/** @type {import("../model.definition").PlatformConfig} */
const platformConfig = {
  name: "anthropic",
  variant: "default",
  baseURL: "https://api.anthropic.com",
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
};
/** @type {import("../model").CallModel} */
const modelCaller = (input) =>
  callAnthropicModel(platformConfig, modelConfig, input);

(async () => {
  if (provider === "gemini") {
    const webSearchTool = createWebSearchTool({
      provider: "gemini",
      apiKey: process.env.GEMINI_API_KEY ?? "",
      model: "gemini-3.8-flash",
    });

    const answer = await webSearchTool.impl({
      searches: SEARCHES,
      question: QUESTION,
    });
    console.log(answer);
    return;
  }

  if (provider === "bedrock-agentcore") {
    const webSearchTool = createWebSearchTool({
      provider: "bedrock-agentcore",
      region: process.env.AWS_REGION ?? "us-east-1",
      awsProfile: process.env.AWS_PROFILE ?? "default",
      maxResults: 5,
      modelCaller,
    });
    const answer = await webSearchTool.impl({
      searches: SEARCHES,
      question: QUESTION,
    });
    console.log(answer);
    return;
  }

  if (provider === "command") {
    const webSearchTool = createWebSearchTool({
      provider: "command",
      command: process.env.WEB_SEARCH_COMMAND ?? "echo",
      args: (process.env.WEB_SEARCH_ARGS ?? "").split(" ").filter(Boolean),
      modelCaller,
    });

    const answer = await webSearchTool.impl({
      searches: SEARCHES,
      question: QUESTION,
    });
    console.log(answer);
    return;
  }

  throw new Error(`Unknown provider: ${provider}`);
})();
