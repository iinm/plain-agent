import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

(async () => {
  // Minimal MCP client over stdio (JSON-RPC 2.0)
  const childProcess = spawn("npx", ["@playwright/mcp@latest", "--headless"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const rl = createInterface({ input: childProcess.stdout });
  let nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (reason: any) => void }>} */
  const pending = new Map();

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if ("id" in msg && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          p?.reject(new Error(msg.error.message));
        } else {
          p?.resolve(msg.result);
        }
      }
    } catch {
      // ignore
    }
  });

  /** @param {string} method @param {Record<string, unknown>} [params] */
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      childProcess.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  };

  // Initialize
  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "playground", version: "0.0.0" },
  });
  childProcess.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );

  // Navigate
  const navigateResult = await request("tools/call", {
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
  const screenshotResult = await request("tools/call", {
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

  rl.close();
  childProcess.stdin.end();
  childProcess.kill();
  process.exit(0);
})();
