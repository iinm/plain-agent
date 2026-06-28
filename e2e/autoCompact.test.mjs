import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import {
  closeAndWaitForExit,
  minimalEnv,
  SSE_HEADERS,
  spawnAgent,
  sseTextResponse,
  sseToolCallResponse,
  waitForCliReady,
  waitForOutput,
} from "./helpers.mjs";

describe("auto-compact", () => {
  /** @type {(() => Promise<void>)[]} */
  const cleanups = [];

  afterEach(async () => {
    for (const cleanup of [...cleanups].reverse()) {
      await cleanup();
    }
    cleanups.length = 0;
  });

  /** @type {import("node:http").Server} */
  let server;
  /** @type {number} */
  let port;
  /** @type {string} */
  let workDir;
  /** @type {(body: string) => string | Promise<string>} */
  let respondWith;

  before(async () => {
    // given: fake OpenAI-compatible server
    server = createServer((req, res) => {
      /** @type {string[]} */
      const chunks = [];
      req.on("data", (/** @type {Buffer} */ d) => chunks.push(d.toString()));
      req.on("end", async () => {
        const body = chunks.join("");
        res.writeHead(200, SSE_HEADERS);
        res.end(await respondWith(body));
      });
    });
    await /** @type {Promise<void>} */ (
      new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    );
    port = /** @type {import("node:net").AddressInfo} */ (server.address())
      .port;

    // given: temp working directory with git repo
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "plain-agent-e2e-"));
    execFileSync("git", ["init"], { cwd: workDir, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: workDir,
      stdio: "ignore",
      env: {
        ...minimalEnv(workDir),
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@localhost",
      },
    });

    // given: project config with autoCompact.softLimit set very low
    const projectConfigDir = path.join(workDir, ".plain-agent");
    await fs.mkdir(projectConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(projectConfigDir, "config.json"),
      JSON.stringify({
        model: "fake+default",
        models: [
          {
            name: "fake",
            variant: "default",
            platform: { name: "openai-compatible", variant: "fake" },
            model: {
              format: "openai-messages",
              config: { model: "fake-model" },
            },
            autoCompact: { inputTokensKeys: ["prompt_tokens"] },
          },
        ],
        platforms: [
          {
            name: "openai-compatible",
            variant: "fake",
            baseURL: `http://localhost:${port}`,
            apiKey: "test-key",
          },
        ],
        autoCompact: { softLimit: 1 },
      }),
    );
  });

  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it("should insert auto-compact prompt after tool results when input tokens exceed soft limit", async () => {
    // given: model returns a tool call (ls) with high token usage, then text
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
    };
    let callCount = 0;
    respondWith = () => {
      callCount++;
      if (callCount === 1) {
        return sseToolCallResponse("call_ls", "exec_command", {
          command: "ls",
        });
      }
      return sseTextResponse("done", { usage });
    };
    const { proc, output } = spawnAgent(workDir);
    cleanups.push(() => closeAndWaitForExit(proc));

    // when:
    await waitForCliReady(proc, output);
    proc.stdin.write("list files\n");

    // then: auto-compact prompt is inserted after tool results
    await waitForOutput(output, /Context exceeded soft limit/, 5000);
    const full = output.join("");
    assert.ok(
      full.includes("Auto-compact prompt inserted"),
      `Expected auto-compact diagnostic message, got: ${full}`,
    );
  });
});
