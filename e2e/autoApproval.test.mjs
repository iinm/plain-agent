import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import {
  closeAndWaitForExit,
  minimalEnv,
  SSE_HEADERS,
  spawnAgent,
  sseTextResponse,
  sseToolCallResponse,
  sseToolCallsResponse,
  waitForCliReady,
  waitForOutput,
} from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("auto-approval", () => {
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

    // given: project config placed at .plain-agent/config.json in the working directory
    const projectConfigDir = path.join(workDir, ".plain-agent");
    await fs.mkdir(projectConfigDir, { recursive: true });
    const template = await fs.readFile(
      path.join(__dirname, "fixtures/config.template.json"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(projectConfigDir, "config.json"),
      template.replace("__PORT__", String(port)),
    );
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
    cleanups.push(() => closeAndWaitForExit(proc));

    // when:
    await waitForCliReady(proc, output);
    proc.stdin.write("list files\n");

    // then: ls runs and the model continues without asking for approval
    await waitForOutput(output, /ls-done/, 2000);
    const full = output.join("");
    assert.ok(
      !full.includes("Approve"),
      `Expected no approval prompt for ls, got: ${full}`,
    );
  });

  it("should require confirmation for rm command", async () => {
    // given: model returns tool_call for rm
    respondWith = () =>
      sseToolCallResponse("call_rm", "exec_command", {
        command: "rm",
        args: ["file.txt"],
      });
    const { proc, output } = spawnAgent(workDir);
    cleanups.push(() => closeAndWaitForExit(proc));

    // when:
    await waitForCliReady(proc, output);
    proc.stdin.write("remove a file\n");

    // then: approval prompt appears
    await waitForOutput(output, /Approve 1 tool call\?/, 2000);
  });

  it("shows approval reasons and resolved symlink paths above the batch prompt", async () => {
    // given:
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "plain-agent-target-"),
    );
    cleanups.push(() => fs.rm(outside, { recursive: true, force: true }));
    const link = path.join(workDir, "linked-dir");
    await fs.symlink(outside, link);
    cleanups.push(() => fs.unlink(link));
    const requestedPath = "linked-dir/missing.txt";
    const resolvedPath = path.join(await fs.realpath(outside), "missing.txt");
    respondWith = () =>
      sseToolCallsResponse([
        { toolCallId: "ls", toolName: "exec_command", args: { command: "ls" } },
        {
          toolCallId: "read",
          toolName: "read_file",
          args: { filePath: requestedPath },
        },
        {
          toolCallId: "rg",
          toolName: "exec_command",
          args: { command: "rg", args: ["--follow", "test"] },
        },
        {
          toolCallId: "rm",
          toolName: "exec_command",
          args: { command: "rm", args: ["file.txt"] },
        },
      ]);
    const { proc, output } = spawnAgent(workDir);
    cleanups.push(() => closeAndWaitForExit(proc));

    // when:
    await waitForCliReady(proc, output);
    proc.stdin.write("inspect project files\n");
    await waitForOutput(output, /Approve all 4 tool calls\?/, 2000);

    // then:
    const rendered = output.join("");
    assert.match(
      stripVTControlCharacters(rendered),
      /total_tokens: 15\r?\n\r?\nManual approval required/,
    );
    const heading = rendered.indexOf(
      "Manual approval required for 3 of 4 tool calls",
    );
    assert.ok(heading >= 0, rendered);
    const toolCall = rendered.indexOf(`filePath: ${requestedPath}`);
    assert.ok(toolCall >= 0 && toolCall < heading, rendered);
    const prompt = rendered.slice(heading);
    assert.doesNotMatch(prompt, /#1 exec_command/);
    assert.match(
      prompt,
      /#2 read_file — Path validation failed: path is outside the working directory and not in allowedPaths/,
    );
    assert.ok(
      prompt.includes(
        `${JSON.stringify(requestedPath)} → ${JSON.stringify(resolvedPath)}`,
      ),
      prompt,
    );
    assert.ok(
      prompt.includes(
        '#3 exec_command — Matched approval rule with action "ask"',
      ),
      prompt,
    );
    assert.ok(
      prompt.includes(
        '#4 exec_command — No approval rule matched (default action is "ask")',
      ),
      prompt,
    );
    assert.match(prompt, /session: .*\r?\n.*Approve all 4 tool calls\?/);
  });

  it("should show approval prompt when Ctrl-C is pressed before auto-approved tool execution", async () => {
    // given: model returns auto-approvable ls command after a delay
    respondWith = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            sseToolCallResponse("call_ls", "exec_command", { command: "ls" }),
          );
        }, 500);
      });
    const { proc, output } = spawnAgent(workDir);
    cleanups.push(() => closeAndWaitForExit(proc));

    // when: send input, then Ctrl-C while model is responding
    await waitForCliReady(proc, output);
    proc.stdin.write("list files\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    proc.stdin.write("\x03");

    // then: approval prompt appears instead of auto-executing
    await waitForOutput(output, /Approve 1 tool call\?/, 3000);
  });
});
