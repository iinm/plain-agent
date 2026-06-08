import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
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

describe("auto-approval E2E", () => {
  /** @type {import("node:http").Server} */
  let server;
  /** @type {number} */
  let port;
  /** @type {string} */
  let workDir;
  /** @type {(body: string) => string} */
  let respondWith;

  before(async () => {
    // given: fake OpenAI-compatible server that delegates to `respondWith`
    server = createServer((req, res) => {
      /** @type {string[]} */
      const chunks = [];
      req.on("data", (/** @type {Buffer} */ d) => chunks.push(d.toString()));
      req.on("end", () => {
        const body = chunks.join("");
        res.writeHead(200, SSE_HEADERS);
        res.end(respondWith(body));
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
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

    // given: user config placed at ~/.config/plain-agent/config.json
    const userConfigDir = path.join(workDir, ".config", "plain-agent");
    await fs.mkdir(userConfigDir, { recursive: true });
    const template = await fs.readFile(
      path.join(__dirname, "fixtures/config.template.json"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(userConfigDir, "config.json"),
      template.replace("__PORT__", String(port)),
    );

    // given: default handler
    respondWith = () => sseTextResponse("Hello from fake model!");
  });

  after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it("should auto-approve ls command from predefined config", async () => {
    // given: first call returns tool_call for ls, second returns text
    let callCount = 0;
    respondWith = () => {
      callCount++;
      if (callCount === 1) {
        return sseToolCallResponse("call_ls", "exec_command", {
          command: "ls",
        });
      }
      return sseTextResponse("ls-done");
    };
    const { proc, output } = spawnAgent(workDir);

    // when:
    await waitForCliReady(proc, output);
    proc.stdin?.write("list files\n");

    // then: ls runs and the model continues without asking for approval
    await waitForOutput(output, /ls-done/, 15000);
    const full = output.join("");
    assert.ok(
      !full.includes("Approve"),
      `Expected no approval prompt for ls, got: ${full}`,
    );

    await closeAndWaitForExit(proc);
  });

  it("should require confirmation for rm command", async () => {
    // given: model returns tool_call for rm
    respondWith = () =>
      sseToolCallResponse("call_rm", "exec_command", {
        command: "rm",
        args: ["file.txt"],
      });
    const { proc, output } = spawnAgent(workDir);

    // when:
    await waitForCliReady(proc, output);
    proc.stdin?.write("remove a file\n");

    // then: approval prompt appears
    await waitForOutput(output, /Approve.*tool call/, 15000);

    await closeAndWaitForExit(proc);
  });
});
