import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.dirname(__dirname);

/**
 * Build an OpenAI-compatible SSE stream for a single assistant text chunk.
 * @param {string} text
 */
function makeSseResponse(text) {
  const chunk = JSON.stringify({
    id: "test-id",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  });
  const done = JSON.stringify({
    id: "test-id",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  return `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
}

describe("main E2E", () => {
  /** @type {import("node:http").Server} */
  let server;
  /** @type {number} */
  let port;
  /** @type {string} */
  let configPath;
  /** @type {string} */
  let workDir;

  before(async () => {
    // given: fake OpenAI-compatible server
    server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Transfer-Encoding": "chunked",
        });
        res.end(makeSseResponse("Hello from fake model!"));
      });
    });
    await /** @type {Promise<void>} */ (
      new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    );
    port = /** @type {import("node:net").AddressInfo} */ (server.address())
      .port;

    // given: temp working directory used as HOME
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "plain-agent-e2e-"));

    // given: config file derived from template
    const template = await fs.readFile(
      path.join(__dirname, "fixtures/config.template.json"),
      "utf-8",
    );
    const configContent = template.replace("__PORT__", String(port));
    configPath = path.join(workDir, "config.json");
    await fs.writeFile(configPath, configContent);

    // given: pre-trust config hash (TOFU) so the non-TTY child process loads it
    const hash = crypto
      .createHash("sha256")
      .update(configContent)
      .digest("hex");
    const trustedDir = path.join(
      workDir,
      ".cache",
      "plain-agent",
      "trusted-config-hashes",
    );
    await fs.mkdir(trustedDir, { recursive: true });
    await fs.writeFile(path.join(trustedDir, hash), "");
  });

  after(async () => {
    server.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("ユーザー入力に対してエージェントが応答する", async () => {
    // when: spawn the agent as a child process
    const proc = spawn(
      "node",
      [path.join(AGENT_ROOT, "bin/plain"), "--config", configPath],
      {
        cwd: workDir,
        env: {
          ...process.env,
          HOME: workDir,
          NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
        },
      },
    );

    /** @type {string[]} */
    const output = [];
    proc.stdout.on("data", (d) => output.push(d.toString()));
    proc.stderr.on("data", (d) => output.push(d.toString()));

    /**
     * Poll output until a pattern appears or timeout expires.
     * @param {RegExp} pattern
     * @param {number} timeoutMs
     */
    const waitForOutput = (pattern, timeoutMs) =>
      new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          if (pattern.test(output.join(""))) {
            clearInterval(interval);
            resolve(undefined);
          }
        }, 100);
        setTimeout(() => {
          clearInterval(interval);
          reject(
            new Error(
              `Timed out waiting for ${pattern}, got: ${output.join("")}`,
            ),
          );
        }, timeoutMs);
      });

    // when: wait for the prompt to appear (CLI ready)
    await waitForOutput(/[$>] ?$|\n$/m, 5000);

    // when: send user input
    proc.stdin.write("hello\n");

    // when: wait for fake model response to appear in output
    await waitForOutput(/Hello from fake model!/, 10000);

    // when: close stdin to trigger readline "close" → handleExit → process.exit
    proc.stdin.end();

    // when: wait for process to close
    await new Promise((resolve, reject) => {
      proc.on("close", resolve);
      proc.on("error", reject);
      setTimeout(
        () => reject(new Error("Process did not exit in time")),
        10000,
      );
    });

    // then: output includes the fake model response
    const fullOutput = output.join("");
    assert.ok(
      fullOutput.includes("Hello from fake model!"),
      `Expected output to include "Hello from fake model!", got: ${fullOutput}`,
    );
  });
});
