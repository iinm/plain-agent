import assert from "node:assert";
import { describe, it } from "node:test";
import { createTmuxCommandTool } from "./tmuxCommand.mjs";

describe("tmuxCommandTool env and secrets", () => {
  it("passes env and secrets to new-session with -e", async () => {
    // given:
    const tool = createTmuxCommandTool({
      env: { FOO: "bar" },
      secrets: { SECRET: "s3cr3t" },
      sandbox: { command: "echo", args: ["SANDBOX"] },
    });

    // when:
    const result = await tool.impl({
      command: "new-session",
      args: ["-d", "-s", "plain-agent-test"],
    });

    // then: the secret value is masked, but the -e flag is present
    assert.match(
      String(result),
      /SANDBOX tmux new-session -e FOO=bar -e SECRET=\*\*\* -d -s plain-agent-test/,
    );
  });

  it("does not add -e to non session commands", async () => {
    // given:
    const tool = createTmuxCommandTool({
      env: { FOO: "bar" },
      sandbox: { command: "echo", args: [] },
    });

    // when:
    const result = await tool.impl({ command: "list-sessions", args: [] });

    // then:
    assert.doesNotMatch(String(result), /-e /);
  });

  it("masks secrets in tmux output", async () => {
    // given:
    const tool = createTmuxCommandTool({
      secrets: { SECRET: "s3cr3t" },
      sandbox: { command: "echo", args: [] },
    });

    // when:
    const result = await tool.impl({
      command: "list-sessions",
      args: ["s3cr3t"],
    });

    // then:
    assert.doesNotMatch(String(result), /s3cr3t/);
    assert.match(String(result), /\*\*\*/);
  });

  it("exposes a maskOutput derived from secrets", () => {
    // given:
    const withSecrets = createTmuxCommandTool({
      secrets: { SECRET: "s3cr3t" },
    });
    const withoutSecrets = createTmuxCommandTool();

    // then:
    assert.equal(withSecrets.maskOutput?.("x s3cr3t y"), "x *** y");
    assert.equal(withoutSecrets.maskOutput?.("x s3cr3t y"), "x s3cr3t y");
  });
});
