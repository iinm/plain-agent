import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.dirname(__dirname);
const BIN = path.join(AGENT_ROOT, "bin/plain");

/** @param {string} text */
function sseTextResponse(text) {
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

/**
 * @param {string} toolCallId
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 */
function sseToolCallResponse(toolCallId, toolName, args) {
  const chunk = JSON.stringify({
    id: "test-id",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
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

/** Standard headers for SSE responses. */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Transfer-Encoding": "chunked",
};

/**
 * Poll collected output until a pattern matches or timeout expires.
 * @param {string[]} output
 * @param {RegExp} pattern
 * @param {number} timeoutMs
 */
function waitForOutput(output, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (pattern.test(output.join(""))) {
        clearInterval(interval);
        resolve(undefined);
      }
    }, 100);
    setTimeout(() => {
      clearInterval(interval);
      reject(
        new Error(`Timed out waiting for ${pattern}, got: ${output.join("")}`),
      );
    }, timeoutMs);
  });
}

/**
 * Minimal env for child processes — avoids leaking the parent's full env.
 * @param {string} home
 */
function minimalEnv(home) {
  /** @type {Record<string, string>} */
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TERM: process.env.TERM ?? "xterm-256color",
  };
  if (process.env.NODE_V8_COVERAGE) {
    env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
  }
  return env;
}

/**
 * Spawn the agent inside a pseudo-TTY via `script -qfec`.
 * @param {string} configPath
 * @param {string} workDir
 */
function spawnAgent(configPath, workDir) {
  const proc = spawn(
    "script",
    ["-qfec", `${BIN} --config ${configPath}`, "/dev/null"],
    { cwd: workDir, env: minimalEnv(workDir) },
  );

  /** @type {string[]} */
  const output = [];
  proc.stdout.on("data", (/** @type {Buffer} */ d) =>
    output.push(d.toString()),
  );
  proc.stderr.on("data", (/** @type {Buffer} */ d) =>
    output.push(d.toString()),
  );

  return { proc, output };
}

/**
 * Approve all TOFU config trust prompts, then wait for the CLI to be ready.
 * Polls output, answering each "Do you want to load this file?" with "y",
 * and stops once the "sandbox:" indicator appears (meaning startup finished).
 * @param {import("node:child_process").ChildProcess} proc
 * @param {string[]} output
 */
async function waitForCliReady(proc, output) {
  const deadline = Date.now() + 15000;
  let answered = 0;

  while (Date.now() < deadline) {
    const full = output.join("");

    if (/sandbox: (on|off)/.test(full)) return;

    const matches = full.match(/Do you want to load this file\?/g);
    const count = matches ? matches.length : 0;
    while (answered < count) {
      proc.stdin?.write("y\n");
      answered++;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for CLI to be ready, got: ${output.join("")}`,
  );
}

/**
 * Close stdin and wait for the process to exit.
 * @param {import("node:child_process").ChildProcess} proc
 */
function closeAndWaitForExit(proc) {
  // Double Ctrl-D triggers the interactive exit handler in the pseudo-TTY.
  proc.stdin?.write("\x04");
  setTimeout(() => proc.stdin?.write("\x04"), 200);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Process did not exit in time"));
    }, 10000);
    proc.on("close", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("auto-approval E2E", () => {
  /** @type {import("node:http").Server} */
  let server;
  /** @type {number} */
  let port;
  /** @type {string} */
  let configPath;
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

    // given: config file derived from template
    const template = await fs.readFile(
      path.join(__dirname, "fixtures/config.template.json"),
      "utf-8",
    );
    configPath = path.join(workDir, "config.json");
    await fs.writeFile(configPath, template.replace("__PORT__", String(port)));

    // given: default handler
    respondWith = () => sseTextResponse("Hello from fake model!");
  });

  after(async () => {
    server?.close();
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it("should load predefined config and user project config", async () => {
    // given:
    respondWith = () => sseTextResponse("config-check-ok");
    const { proc, output } = spawnAgent(configPath, workDir);

    // when: approve TOFU prompts and wait for CLI
    await waitForCliReady(proc, output);

    // then: both configs appear in the startup output
    const full = output.join("");
    assert.ok(
      full.includes("config.predefined.json"),
      `Expected predefined config in startup output, got: ${full}`,
    );
    assert.ok(
      full.includes("config.json"),
      `Expected user config in startup output, got: ${full}`,
    );

    await closeAndWaitForExit(proc);
  });

  it("should respond to user input via the fake model", async () => {
    // given:
    respondWith = () => sseTextResponse("Hello from fake model!");
    const { proc, output } = spawnAgent(configPath, workDir);

    // when:
    await waitForCliReady(proc, output);
    proc.stdin?.write("hello\n");

    // then:
    await waitForOutput(output, /Hello from fake model!/, 10000);

    await closeAndWaitForExit(proc);
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
    const { proc, output } = spawnAgent(configPath, workDir);

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
    const { proc, output } = spawnAgent(configPath, workDir);

    // when:
    await waitForCliReady(proc, output);
    proc.stdin?.write("remove a file\n");

    // then: approval prompt appears
    await waitForOutput(output, /Approve.*tool call/, 15000);

    await closeAndWaitForExit(proc);
  });
});
