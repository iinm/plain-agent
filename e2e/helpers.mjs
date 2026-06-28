import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.dirname(__dirname);
const BIN = path.join(AGENT_ROOT, "bin/plain");

/**
 * Minimal env for child processes — avoids leaking the parent's full env.
 * @param {string} home
 * @returns {Record<string, string>}
 */
export function minimalEnv(home) {
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
 * Poll collected output until a pattern matches or timeout expires.
 * @param {string[]} output
 * @param {RegExp} pattern
 * @param {number} timeoutMs
 */
export async function waitForOutput(output, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(output.join(""))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${pattern}, got: ${output.join("")}`);
}

/**
 * Spawn the agent inside a pseudo-TTY via `script -qfec`.
 * @param {string} workDir
 * @returns {{ proc: import("node:child_process").ChildProcessWithoutNullStreams, output: string[] }}
 */
export function spawnAgent(workDir) {
  const proc =
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */ (
      spawn("script", ["-qfec", `${BIN}`, "/dev/null"], {
        cwd: workDir,
        env: minimalEnv(workDir),
      })
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
 * Approve all config trust prompts, then wait for the CLI to be ready.
 * Polls output, answering each "Do you want to load this file?" with "y",
 * and stops once "model: fake+default" appears (meaning startup finished).
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} proc
 * @param {string[]} output
 */
export async function waitForCliReady(proc, output) {
  const deadline = Date.now() + 15000;
  let answered = 0;

  while (Date.now() < deadline) {
    const full = output.join("");

    if (/model: fake\+default/.test(full)) return;

    const matches = full.match(/Do you want to load this file\?/g);
    const count = matches ? matches.length : 0;
    while (answered < count) {
      proc.stdin.write("y\n");
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
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} proc
 */
export function closeAndWaitForExit(proc) {
  // Double Ctrl-D triggers the interactive exit handler in the pseudo-TTY.
  proc.stdin.write("\x04");
  const ctrlDTimer = setTimeout(() => proc.stdin.write("\x04"), 200);
  ctrlDTimer.unref();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Process did not exit in time"));
    }, 10000);
    timer.unref();
    proc.on("close", () => {
      clearTimeout(timer);
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.stdin.destroy();
      resolve(undefined);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * @param {string} text
 * @param {object} [options]
 * @param {Record<string, number>} [options.usage]
 */
export function sseTextResponse(text, options) {
  const usage = options?.usage ?? {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  };
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
    usage,
  });
  return `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
}

/**
 * @param {string} toolCallId
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 */
export function sseToolCallResponse(toolCallId, toolName, args) {
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
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Transfer-Encoding": "chunked",
};
