import assert from "node:assert";
import { describe, it } from "node:test";
import { runTestApprovalCommand } from "./testApproval.mjs";

/**
 * @param {{ toolName: string; action: import("../tool").ToolUsePattern["action"]; source: string; input?: Record<string, unknown> }} p
 * @returns {import("../tool").ToolUsePattern & { source: string }}
 */
function pattern(p) {
  return p;
}

/**
 * @param {{ desc: string; toolUse: { toolName: string; input?: Record<string, unknown> }; expectedAction: import("../config").AutoApprovalTestCase["expectedAction"]; source: string }} t
 * @returns {import("../config").AutoApprovalTestCase & { source: string }}
 */
function testCase(t) {
  return t;
}

/**
 * @param {{ patterns?: ReturnType<typeof pattern>[]; tests?: ReturnType<typeof testCase>[] }} opts
 * @returns {import("../config").AppConfig}
 */
function makeConfig(opts) {
  return /** @type {any} */ ({
    autoApproval: {
      patterns: opts.patterns ?? [],
      tests: opts.tests ?? [],
    },
  });
}

describe("runTestApprovalCommand", () => {
  it("returns 0 when no test cases exist", () => {
    // given:
    const appConfig = makeConfig({});

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });

  it("returns 0 when all tests pass", () => {
    // given:
    const appConfig = makeConfig({
      patterns: [
        pattern({ toolName: "read_file", action: "allow", source: "a.json" }),
      ],
      tests: [
        testCase({
          desc: "read_file should be allowed",
          toolUse: { toolName: "read_file" },
          expectedAction: "allow",
          source: "a.json",
        }),
      ],
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });

  it("returns 0 when test expects no match and nothing matches", () => {
    // given:
    const appConfig = makeConfig({
      patterns: [
        pattern({ toolName: "read_file", action: "allow", source: "a.json" }),
      ],
      tests: [
        testCase({
          desc: "write_file should not match",
          toolUse: { toolName: "write_file" },
          expectedAction: null,
          source: "a.json",
        }),
      ],
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });

  it("returns 1 when a test fails (same source)", () => {
    // given:
    const appConfig = makeConfig({
      patterns: [
        pattern({ toolName: "read_file", action: "allow", source: "a.json" }),
      ],
      tests: [
        testCase({
          desc: "read_file should be denied",
          toolUse: { toolName: "read_file" },
          expectedAction: "deny",
          source: "a.json",
        }),
      ],
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 1);
  });

  it("returns 0 (warn) when overridden by a different config", () => {
    // given:
    const appConfig = makeConfig({
      patterns: [
        pattern({
          toolName: "read_file",
          action: "allow",
          source: "user.json",
        }),
      ],
      tests: [
        testCase({
          desc: "read_file should be denied",
          toolUse: { toolName: "read_file" },
          expectedAction: "deny",
          source: "predefined.json",
        }),
      ],
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });

  it("returns 1 when a test fails even with some warnings", () => {
    // given:
    const appConfig = makeConfig({
      patterns: [
        pattern({
          toolName: "read_file",
          action: "allow",
          source: "user.json",
        }),
        pattern({
          toolName: "exec_command",
          action: "allow",
          source: "a.json",
        }),
      ],
      tests: [
        testCase({
          desc: "read_file overridden (warn)",
          toolUse: { toolName: "read_file" },
          expectedAction: "deny",
          source: "predefined.json",
        }),
        testCase({
          desc: "exec_command wrong action (fail)",
          toolUse: { toolName: "exec_command" },
          expectedAction: "deny",
          source: "a.json",
        }),
      ],
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 1);
  });

  it("treats expectedAction null as expecting no pattern match", () => {
    // given:
    const appConfig = makeConfig({
      patterns: [
        pattern({ toolName: "read_file", action: "allow", source: "a.json" }),
      ],
      tests: [
        testCase({
          desc: "read_file should not match (but does)",
          toolUse: { toolName: "read_file" },
          expectedAction: null,
          source: "a.json",
        }),
      ],
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 1);
  });

  it("fails when no pattern matches but a match was expected", () => {
    // given:
    const appConfig = makeConfig({
      tests: [
        testCase({
          desc: "read_file should be allowed",
          toolUse: { toolName: "read_file" },
          expectedAction: "allow",
          source: "a.json",
        }),
      ],
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 1);
  });

  it("matches patterns with input constraints", () => {
    // given:
    const appConfig = makeConfig({
      patterns: [
        pattern({
          toolName: "exec_command",
          input: { command: "ls" },
          action: "allow",
          source: "a.json",
        }),
      ],
      tests: [
        testCase({
          desc: "ls should be allowed",
          toolUse: { toolName: "exec_command", input: { command: "ls" } },
          expectedAction: "allow",
          source: "a.json",
        }),
        testCase({
          desc: "rm should not match",
          toolUse: { toolName: "exec_command", input: { command: "rm" } },
          expectedAction: null,
          source: "a.json",
        }),
      ],
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });
});
