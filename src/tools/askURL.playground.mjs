import { createAskURLTool } from "./askURL.mjs";

(async () => {
  const askURLTool = createAskURLTool({
    provider: "gemini",
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: "gemini-3-flash-preview",
  });

  const answer = await askURLTool.impl({
    question:
      "https://iinm.github.io/posts/2026-02-28--coding-agent-permission-control.html 要点を教えて",
  });

  console.log(answer);
})();
