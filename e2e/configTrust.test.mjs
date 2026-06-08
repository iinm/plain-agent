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
  waitForOutput,
} from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Wait until the trust prompt appears n times in the accumulated output.
 * @param {string[]} output
 * @param {number} n
 * @param {number} timeoutMs
 */
async function waitForNthTrustPrompt(output, n, timeoutMs) {
  const pattern = /Do you want to load this file\?/g;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = output.join("").match(pattern);
    if (matches && matches.length >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for trust prompt #${n}, got: ${output.join("")}`,
  );
}

describe("config trust", () => {
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

  it("should prompt for each config file and load them when approved", async () => {
    // given:
    respondWith = () => sseTextResponse("config-loaded-ok");
    const { proc, output } = spawnAgent(workDir);

    // when: first trust prompt appears (predefined config)
    await waitForNthTrustPrompt(output, 1, 10000);

    // then: prompt mentions the predefined config
    assert.ok(
      output.join("").includes("config.predefined.json"),
      `Expected predefined config in first prompt, got: ${output.join("")}`,
    );

    // when: approve predefined config
    proc.stdin.write("y\n");

    // when: second trust prompt appears (project config)
    await waitForNthTrustPrompt(output, 2, 10000);

    // then: prompt mentions the project config
    assert.ok(
      output.join("").includes(".plain-agent/config.json"),
      `Expected project config in second prompt, got: ${output.join("")}`,
    );

    // when: approve project config
    proc.stdin.write("y\n");

    // then: CLI becomes ready with the fake model loaded
    await waitForOutput(output, /model: fake\+default/, 10000);

    await closeAndWaitForExit(proc);
  });
});
