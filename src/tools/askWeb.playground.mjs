import { createAskWebTool } from "./askWeb.mjs";

(async () => {
  const askWebTool = createAskWebTool({
    provider: "gemini",
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: "gemini-3-flash-preview",
  });

  const answer = await askWebTool.impl({
    question: "明日の東京の天気を調べて",
  });
  // const answer = await askWebTool.impl({
  //   question:
  //     "明日の東京ディズニーランドの混雑予想が知りたい。複数の情報源を比較してください。",
  // });

  console.log(answer);
})();
