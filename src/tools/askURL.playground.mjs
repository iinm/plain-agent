import { callAnthropicModel } from "../providers/anthropic.mjs";
import { createAskURLTool } from "./askURL.mjs";

const QUESTION =
  "https://iinm.github.io/posts/2026-02-28--coding-agent-permission-control.html 要点を教えて";

const provider = process.argv[2] ?? "gemini";

(async () => {
  if (provider === "gemini") {
    const askURLTool = createAskURLTool({
      provider: "gemini",
      apiKey: process.env.GEMINI_API_KEY ?? "",
      model: "gemini-3-flash-preview",
    });

    const answer = await askURLTool.impl({ question: QUESTION });
    console.log(answer);
    return;
  }

  if (provider === "builtin+command") {
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
    const askURLTool = createAskURLTool({
      provider: "builtin+command",
      command: process.env.ASK_URL_COMMAND ?? "w3m",
      args: (process.env.ASK_URL_ARGS ?? "-dump").split(" ").filter(Boolean),
      modelCaller: (input) =>
        callAnthropicModel(platformConfig, modelConfig, input),
    });

    const answer = await askURLTool.impl({ question: QUESTION });
    console.log(answer);
    return;
  }

  throw new Error(`Unknown provider: ${provider}`);
})();
