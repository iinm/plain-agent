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
