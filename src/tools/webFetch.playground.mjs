import { callAnthropicModel } from "../providers/anthropic.mjs";
import { createWebFetchTool } from "./webFetch.mjs";

const URL =
  "https://iinm.github.io/posts/2026-02-28--coding-agent-permission-control.html";
const QUESTION = "要点を教えて";

const provider = process.argv[2] ?? "gemini";

(async () => {
  if (provider === "gemini") {
    const webFetchTool = createWebFetchTool({
      provider: "gemini",
      apiKey: process.env.GEMINI_API_KEY ?? "",
      model: "gemini-3.5-flash",
    });

    const answer = await webFetchTool.impl({ url: URL, question: QUESTION });
    console.log(answer);
    return;
  }

  if (provider === "command") {
    /** @type {import("../providers/anthropic").AnthropicModelConfig} */
    const modelConfig = {
      model: "claude-haiku-4-5",
      max_tokens: 8192,
    };
    /** @type {import("../modelDefinition").PlatformConfig} */
    const platformConfig = {
      name: "anthropic",
      variant: "default",
      baseURL: "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    };
    const webFetchTool = createWebFetchTool({
      provider: "command",
      command: process.env.WEB_FETCH_COMMAND ?? "w3m",
      args: (process.env.WEB_FETCH_ARGS ?? "-dump").split(" ").filter(Boolean),
      modelCaller: (input) =>
        callAnthropicModel(platformConfig, modelConfig, input),
    });

    const answer = await webFetchTool.impl({ url: URL, question: QUESTION });
    console.log(answer);
    return;
  }

  throw new Error(`Unknown provider: ${provider}`);
})();
