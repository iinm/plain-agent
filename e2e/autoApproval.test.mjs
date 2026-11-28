import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { lineHash } from "../src/utils/lineHash.mjs";

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

  it("shows original patch lines only for files eligible for auto-approved reads", async () => {
    // given:
    const visible = "visible original";
    const hidden = "ignored original";
    const paths = ["preview-visible.txt", "preview-ignored.txt"];
    const excludePath = path.join(workDir, ".git", "info", "exclude");
    const exclude = await fs.readFile(excludePath, "utf8");
    cleanups.push(() => fs.writeFile(excludePath, exclude));
    await fs.appendFile(excludePath, "\n/preview-ignored.txt\n");
    for (const [filePath, line] of [
      [paths[0], visible],
      [paths[1], hidden],
    ]) {
      const target = path.join(workDir, filePath);
      await fs.writeFile(target, `${line}\n`);
      cleanups.push(() => fs.unlink(target));
    }
    respondWith = () =>
      sseToolCallsResponse(
        paths.map((filePath, i) => ({
          toolCallId: `patch-${i}`,
          toolName: "patch_file",
          args: {
            filePath,
            patch: `REPLACE abc 1:${lineHash(i === 0 ? visible : hidden)}\nreplacement ${i}`,
          },
        })),
      );
    const { proc, output } = spawnAgent(workDir);
    cleanups.push(() => closeAndWaitForExit(proc));

    // when:
    await waitForCliReady(proc, output);
    proc.stdin.write("prepare the patches\n");
    await waitForOutput(output, /Approve 2 tool calls\?/, 2000);

    // then:
    const rendered = stripVTControlCharacters(output.join(""));
    assert.ok(rendered.includes(`  | - ${visible}`), rendered);
    assert.ok(rendered.includes("  | replacement 1"), rendered);
    assert.ok(!rendered.includes(hidden), rendered);
  });

  it("uses the configured sandbox for built-in file access and previews", async () => {
    // given: a wrapper that executes relative to a separate filesystem view.
    const sandboxDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "plain-agent-view-"),
    );
    cleanups.push(() => fs.rm(sandboxDir, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q"], { cwd: sandboxDir });
    const hostExcludePath = path.join(workDir, ".git", "info", "exclude");
    const hostExclude = await fs.readFile(hostExcludePath, "utf8");
    cleanups.push(() => fs.writeFile(hostExcludePath, hostExclude));
    await fs.appendFile(
      hostExcludePath,
      "\nread.txt\nnew/\nsandbox-patch.txt\n",
    );

    const patchedPath = "sandbox-patch.txt";
    const ignoredPath = "sandbox-ignored.txt";
    const ignoredSource = "old line from sandbox-ignored file";
    await fs.writeFile(
      path.join(sandboxDir, ".gitignore"),
      `${ignoredPath}\nimage.png\n`,
    );
    await fs.writeFile(
      path.join(sandboxDir, ignoredPath),
      `${ignoredSource}\n`,
    );
    const outsidePath = "host-only.txt";
    const source = "sandbox original";
    const hostSource = "host original";
    await fs.writeFile(path.join(sandboxDir, patchedPath), `${source}\n`);
    await fs.writeFile(
      path.join(sandboxDir, "read.txt"),
      "sandbox read\n".repeat(30_000),
    );
    const image = await fs.readFile(
      path.join(__dirname, "../src/utils/test/iinm.png"),
    );
    await fs.writeFile(path.join(sandboxDir, "image.png"), image);
    await fs.writeFile(path.join(workDir, patchedPath), hostSource);
    await fs.writeFile(path.join(workDir, outsidePath), "host-only contents");
    cleanups.push(() => fs.unlink(path.join(workDir, patchedPath)));
    cleanups.push(() => fs.unlink(path.join(workDir, outsidePath)));

    const configPath = path.join(workDir, ".plain-agent", "config.json");
    const originalConfig = await fs.readFile(configPath, "utf8");
    cleanups.push(() => fs.writeFile(configPath, originalConfig));
    const config = JSON.parse(originalConfig);
    config.sandbox = {
      command: "sh",
      args: ["-c", 'cd "$1" && shift && exec "$@"', "test-wrapper", sandboxDir],
      rules: [{ pattern: { command: "cat" }, mode: "unsandboxed" }],
    };
    config.autoApproval ??= {};
    config.autoApproval.patterns = [
      { toolName: "patch_file", action: "allow" },
      { toolName: "write_file", action: "allow" },
      ...(config.autoApproval.patterns ?? []),
    ];
    await fs.writeFile(configPath, JSON.stringify(config));

    let toolResults = "";
    let callCount = 0;
    respondWith = (body) => {
      if (callCount++ > 0) {
        toolResults = body;
        return sseTextResponse("file-operations-done");
      }

      const nonce = body.match(/REPLACE ([a-z0-9]+) \{start\}/)?.[1];
      return sseToolCallsResponse([
        {
          toolCallId: "read",
          toolName: "read_file",
          args: { filePath: "read.txt", limit: 1 },
        },
        {
          toolCallId: "outside",
          toolName: "read_file",
          args: { filePath: outsidePath },
        },
        {
          toolCallId: "image",
          toolName: "read_image",
          args: { filePath: "image.png" },
        },
        {
          toolCallId: "patch",
          toolName: "patch_file",
          args: {
            filePath: patchedPath,
            patch: `REPLACE ${nonce} 1:${lineHash(source)}\nreplacement`,
          },
        },
        {
          toolCallId: "ignored",
          toolName: "patch_file",
          args: {
            filePath: ignoredPath,
            patch: `REPLACE ${nonce} 1:${lineHash(ignoredSource)}\nreplace sandbox-ignored line`,
          },
        },
        {
          toolCallId: "ignored-read",
          toolName: "read_file",
          args: { filePath: ignoredPath },
        },
        {
          toolCallId: "write",
          toolName: "write_file",
          args: {
            filePath: "new/nested.txt",
            content: "日本語 and $HOME\nend",
          },
        },
      ]);
    };

    const { proc, output } = spawnAgent(workDir);
    cleanups.push(() => closeAndWaitForExit(proc));

    // when:
    await waitForCliReady(proc, output);
    proc.stdin.write("run file operations\n");
    await waitForOutput(output, /Approve all 7 tool calls\?/, 3000);

    // then: the preview reads the same view as the tools.
    const rendered = stripVTControlCharacters(output.join(""));
    assert.ok(rendered.includes(`  | - ${source}`), rendered);
    assert.ok(!rendered.includes(hostSource), rendered);
    assert.ok(rendered.includes("replace sandbox-ignored line"), rendered);
    assert.ok(!rendered.includes(ignoredSource), rendered);
    assert.doesNotMatch(
      rendered,
      /#(?:1|2) read_file|#4 patch_file|#7 write_file/,
    );
    assert.match(rendered, /#3 read_image .*path is not managed by git/);
    assert.match(rendered, /#5 patch_file .*path is not managed by git/);
    assert.match(rendered, /#6 read_file .*path is not managed by git/);

    // when:
    proc.stdin.write("y\n");
    await waitForOutput(output, /file-operations-done/, 4000);

    // then: operations used the sandbox view, including failures.
    assert.match(toolResults, /sandbox read/);
    assert.match(
      toolResults,
      /"tool_call_id":"ignored-read","content":"1:[0-9a-f]+[|]/,
    );
    assert.match(toolResults, /Sandbox file operation \(cat\) failed/);
    assert.ok(!toolResults.includes("host-only contents"));
    assert.ok(toolResults.includes(image.toString("base64")));
    assert.equal(
      await fs.readFile(path.join(sandboxDir, patchedPath), "utf8"),
      "replacement\n",
    );
    assert.equal(
      await fs.readFile(path.join(workDir, patchedPath), "utf8"),
      hostSource,
    );
    assert.equal(
      await fs.readFile(path.join(sandboxDir, "new/nested.txt"), "utf8"),
      "日本語 and $HOME\nend",
    );
    await assert.rejects(fs.access(path.join(workDir, "new/nested.txt")), {
      code: "ENOENT",
    });
  });

  it("cancels a pending patch when the sandbox diff times out", async () => {
    // given: a sandbox that stalls during file metadata inspection.
    const configPath = path.join(workDir, ".plain-agent", "config.json");
    const originalConfig = await fs.readFile(configPath, "utf8");
    cleanups.push(() => fs.writeFile(configPath, originalConfig));
    const config = JSON.parse(originalConfig);
    config.sandbox = {
      command: "sh",
      args: [
        "-c",
        'if [ "$1" = sh ]; then exec sleep 30; fi; exec "$@"',
        "test-wrapper",
      ],
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const filePath = "timeout-patch.txt";
    const source = "before the patch";
    await fs.writeFile(path.join(workDir, filePath), `${source}\n`);
    cleanups.push(() => fs.unlink(path.join(workDir, filePath)));
    let calls = 0;
    respondWith = (body) => {
      if (calls++ > 0) return sseTextResponse("ready for another request");
      const nonce = body.match(/REPLACE ([a-z0-9]+) \{start\}/)?.[1];
      return sseToolCallResponse("patch-timeout", "patch_file", {
        filePath,
        patch: `REPLACE ${nonce} 1:${lineHash(source)}\nafter the patch`,
      });
    };

    const { proc, output } = spawnAgent(workDir);
    cleanups.push(() => closeAndWaitForExit(proc));

    // when:
    await waitForCliReady(proc, output);
    proc.stdin.write("apply a patch\n");
    await waitForOutput(output, /Cancelled the pending changes/, 14_000);

    // then:
    assert.doesNotMatch(
      stripVTControlCharacters(output.join("")),
      /Approve 1 tool call/,
    );
    assert.equal(
      await fs.readFile(path.join(workDir, filePath), "utf8"),
      `${source}\n`,
    );
    assert.equal(calls, 1);

    // when: a new request can run after the cancellation.
    proc.stdin.write("next request\n");
    await waitForOutput(output, /ready for another request/, 3000);

    // then:
    assert.equal(calls, 2);
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
    const toolCall = rendered.indexOf(
      `filePath: ${JSON.stringify(requestedPath)}`,
    );
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
