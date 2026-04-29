import { createMCPClient } from "./mcpClient.mjs";

(async () => {
  const client = await createMCPClient({
    command: "npx",
    args: ["@playwright/mcp@latest", "--headless"],
    stderr: "inherit",
  });

  // Navigate
  const navigateResult = await client.callTool({
    name: "browser_navigate",
    arguments: { url: "https://example.com" },
  });
  console.log(JSON.stringify(navigateResult, null, 2));
  // {
  //   content: [
  //     {
  //       type: "text",
  //       text: "Navigated to https://example.com\n\n- Page URL: https://example.com/\n- Page Title: Example Domain\n- Page Snapshot\n"
  //     }
  //   ]
  // }

  // Screenshot
  const screenshotResult = await client.callTool({
    name: "browser_take_screenshot",
    arguments: {},
  });
  console.log(JSON.stringify(screenshotResult, null, 2));
  // {
  //   content: [
  //     {
  //       type: "image",
  //       data: "/9j/4AAQSk...",
  //       mimeType: "image/jpeg"
  //     }
  //   ]
  // }

  await client.close();
  process.exit(0);
})();
