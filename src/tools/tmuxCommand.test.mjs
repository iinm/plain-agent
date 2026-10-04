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

  it("passes -e for the `new` alias and abbreviated command names", async () => {
    // given:
    const tool = createTmuxCommandTool({
      env: { FOO: "bar" },
      sandbox: { command: "echo", args: [] },
    });

    // when:
    const aliasResult = await tool.impl({
      command: "new",
      args: ["-d", "-s", "s1"],
    });
    const abbrevResult = await tool.impl({
      command: "new-s",
      args: ["-d", "-s", "s1"],
    });

    // then:
    assert.match(String(aliasResult), /tmux new -e FOO=bar -d -s s1/);
    assert.match(String(abbrevResult), /tmux new-s -e FOO=bar -d -s s1/);
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

  it("exposes a maskOutput only when secrets are configured", () => {
    // given:
    const withSecrets = createTmuxCommandTool({
      secrets: { SECRET: "s3cr3t" },
    });
    const withoutSecrets = createTmuxCommandTool();

    // then:
    assert.equal(withSecrets.maskOutput?.("x s3cr3t y"), "x *** y");
    assert.equal(withoutSecrets.maskOutput, undefined);
  });
});
