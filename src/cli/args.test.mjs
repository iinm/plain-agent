import assert from "node:assert";
import { describe, it } from "node:test";
import { parseCliArgs } from "./args.mjs";

/**
 * @param {string[]} cliArgs
 */
function parse(cliArgs) {
  const args = parseCliArgs(["node", "plain", ...cliArgs]);
  if (args instanceof Error) {
    throw args;
  }
  return args.subcommand;
}

describe("parseCliArgs (interactive subcommand)", () => {
  it("parses all options", () => {
    // when:
    const sub = parse([
      "-m",
      "foo+default",
      "-c",
      "path/to/additional-config.json",
      "-s",
      "session-id",
    ]);

    // then:
    assert.deepEqual(sub, {
      type: "interactive",
      model: "foo+default",
      config: ["path/to/additional-config.json"],
      session: "session-id",
    });
  });
});

describe("parseCliArgs (batch subcommand)", () => {
  it("parses all options", () => {
    // when:
    const sub = parse([
      "batch",
      "-m",
      "foo+default",
      "-c",
      "path/to/additional-config.json",
      "-s",
      "session-id",
      "--budget-soft-limit",
      "time:60s",
      "--prompt-on-budget-exceed",
      "stop",
      "task description",
    ]);

    // then:
    assert.deepStrictEqual(sub, {
      type: "batch",
      prompt: "task description",
      config: ["path/to/additional-config.json"],
      model: "foo+default",
      session: "session-id",
      budgetSoftLimit: {
        type: "time",
        seconds: 60,
        promptOnExceed: "stop",
      },
    });
  });
});

describe("parseCliArgs (auth subcommand)", () => {
  it("parses login and logout for openai-codex", () => {
    // given: both supported authentication actions
    const actions = ["login", "logout"];

    // when: parsing the provider-specific commands
    const subcommands = actions.map((action) =>
      parse(["auth", action, "openai-codex"]),
    );

    // then: the action and provider are preserved
    assert.deepEqual(subcommands, [
      { type: "auth", action: "login", provider: "openai-codex" },
      { type: "auth", action: "logout", provider: "openai-codex" },
    ]);
  });

  it("rejects incomplete, unsupported, and extra arguments", () => {
    // given: invalid authentication command lines
    const invalidCommands = [
      ["auth", "login"],
      ["auth", "delete", "openai-codex"],
      ["auth", "login", "other-provider"],
      ["auth", "login", "openai-codex", "extra"],
    ];

    // when: parsing each command
    const results = invalidCommands.map((command) =>
      parseCliArgs(["node", "plain", ...command]),
    );

    // then: every command returns the authentication usage error
    for (const result of results) {
      assert.ok(result instanceof Error);
      assert.equal(
        result.message,
        "Usage: plain auth <login|logout> openai-codex",
      );
    }
  });
});

describe("parseCliArgs (sandbox subcommand)", () => {
  it("parses `sandbox -- --tty zsh`", () => {
    // when:
    const sub = parse(["sandbox", "--", "--tty", "zsh"]);

    // then:
    assert.deepEqual(sub, {
      type: "sandbox",
      config: [],
      passthroughArgs: ["--tty", "zsh"],
    });
  });

  it("parses `sandbox -c foo.json -- --tty zsh`", () => {
    // when:
    const sub = parse(["sandbox", "-c", "foo.json", "--", "--tty", "zsh"]);

    // then:
    assert.deepEqual(sub, {
      type: "sandbox",
      config: ["foo.json"],
      passthroughArgs: ["--tty", "zsh"],
    });
  });

  it("supports multiple -c flags before --", () => {
    // when:
    const sub = parse([
      "sandbox",
      "-c",
      "a.json",
      "--config",
      "b.json",
      "--",
      "--tty",
      "zsh",
    ]);

    // then:
    assert.deepEqual(sub, {
      type: "sandbox",
      config: ["a.json", "b.json"],
      passthroughArgs: ["--tty", "zsh"],
    });
  });

  it("passes dash-prefixed args after -- as passthroughArgs", () => {
    // when:
    const sub = parse([
      "sandbox",
      "--",
      "--allow-write",
      "--tty",
      "bash",
      "-c",
      "echo hi",
    ]);

    // then:
    assert.deepEqual(sub, {
      type: "sandbox",
      config: [],
      passthroughArgs: ["--allow-write", "--tty", "bash", "-c", "echo hi"],
    });
  });

  it("returns empty passthroughArgs when no -- is given", () => {
    // when:
    const sub = parse(["sandbox", "-c", "foo.json"]);

    // then:
    assert.deepEqual(sub, {
      type: "sandbox",
      config: ["foo.json"],
      passthroughArgs: [],
    });
  });
});
