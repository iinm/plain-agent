import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("sandbox path validation", () => {
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
    // given: fake OpenAI-compatible server that delegates to `respondWith`
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

    // given: temp working directory used as HOME (also a git repo for path safety checks)
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

    // given: project config with a sandbox whose command is `echo`, and a rule
    // that runs `cat` outside the sandbox
    const projectConfigDir = path.join(workDir, ".plain-agent");
    await fs.mkdir(projectConfigDir, { recursive: true });
    const template = await fs.readFile(
      path.join(__dirname, "fixtures/config.template.json"),
      "utf-8",
    );
    const config = JSON.parse(template.replace("__PORT__", String(port)));
    config.sandbox = {
      command: "echo",
      rules: [{ pattern: { command: "cat" }, mode: "unsandboxed" }],
    };
    await fs.writeFile(
      path.join(projectConfigDir, "config.json"),
      JSON.stringify(config, null, 2),
    );
  });

  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it("should skip path validation for a sandboxed command", async () => {
    // given: model returns an auto-approvable echo command with an unsafe path
    let callCount = 0;
    respondWith = () => {
      callCount++;
      if (callCount === 1) {
        return sseToolCallResponse("call_echo", "exec_command", {
          command: "echo",
          args: ["../outside.txt"],
        });
      }
      return sseTextResponse("sandbox-allowed");
    };
    const { proc, output } = spawnAgent(workDir);
    cleanups.push(() => closeAndWaitForExit(proc));

    // when:
    await waitForCliReady(proc, output);
    proc.stdin.write("echo a path outside the project\n");

    // then: the sandbox is the boundary, so the tool runs without approval
    await waitForOutput(output, /sandbox-allowed/, 3000);
    assert.ok(
      !output.join("").includes("Approve"),
      `Expected no approval prompt for a sandboxed command, got: ${output.join("")}`,
    );
  });

  it("should keep path validation for an unsandboxed command", async () => {
    // given: model returns an auto-approvable cat command with an unsafe path,
    // and cat matches an unsandboxed sandbox rule
    respondWith = () =>
      sseToolCallResponse("call_cat", "exec_command", {
        command: "cat",
        args: ["../outside.txt"],
      });
    const { proc, output } = spawnAgent(workDir);
    cleanups.push(() => closeAndWaitForExit(proc));

    // when:
    await waitForCliReady(proc, output);
    proc.stdin.write("read a path outside the project\n");

    // then: the command runs outside the sandbox, so path validation applies
    await waitForOutput(output, /Approve 1 tool call\?/, 3000);
  });
});
