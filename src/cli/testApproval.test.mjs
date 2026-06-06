import assert from "node:assert";
import { describe, it } from "node:test";
import { runTestApprovalCommand } from "./testApproval.mjs";

describe("runTestApprovalCommand", () => {
  it("returns 0 when no test cases exist", () => {
    // given:
    const appConfig = /** @type {any} */ ({
      autoApproval: { patterns: [] },
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });

  it("returns 0 when all tests pass", () => {
    // given:
    const appConfig = /** @type {any} */ ({
      autoApproval: {
        patterns: [
          { toolName: "read_file", action: "allow", source: "a.json" },
        ],
        tests: [
          {
            desc: "read_file should be allowed",
            toolUse: { toolName: "read_file" },
            expectedAction: "allow",
            source: "a.json",
          },
        ],
      },
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });

  it("returns 0 when test expects no match and nothing matches", () => {
    // given:
    const appConfig = /** @type {any} */ ({
      autoApproval: {
        patterns: [
          { toolName: "read_file", action: "allow", source: "a.json" },
        ],
        tests: [
          {
            desc: "write_file should not match",
            toolUse: { toolName: "write_file" },
            expectedAction: null,
            source: "a.json",
          },
        ],
      },
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });

  it("returns 1 when a test fails (same source)", () => {
    // given:
    const appConfig = /** @type {any} */ ({
      autoApproval: {
        patterns: [
          { toolName: "read_file", action: "allow", source: "a.json" },
        ],
        tests: [
          {
            desc: "read_file should be denied",
            toolUse: { toolName: "read_file" },
            expectedAction: "deny",
            source: "a.json",
          },
        ],
      },
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 1);
  });

  it("returns 0 (warn) when overridden by a different config", () => {
    // given:
    const appConfig = /** @type {any} */ ({
      autoApproval: {
        patterns: [
          { toolName: "read_file", action: "allow", source: "user.json" },
        ],
        tests: [
          {
            desc: "read_file should be denied",
            toolUse: { toolName: "read_file" },
            expectedAction: "deny",
            source: "predefined.json",
          },
        ],
      },
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });

  it("returns 1 when a test fails even with some warnings", () => {
    // given:
    const appConfig = /** @type {any} */ ({
      autoApproval: {
        patterns: [
          { toolName: "read_file", action: "allow", source: "user.json" },
          { toolName: "exec_command", action: "allow", source: "a.json" },
        ],
        tests: [
          {
            desc: "read_file overridden (warn)",
            toolUse: { toolName: "read_file" },
            expectedAction: "deny",
            source: "predefined.json",
          },
          {
            desc: "exec_command wrong action (fail)",
            toolUse: { toolName: "exec_command" },
            expectedAction: "deny",
            source: "a.json",
          },
        ],
      },
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 1);
  });

  it("fails when no pattern matches but a match was expected", () => {
    // given:
    const appConfig = /** @type {any} */ ({
      autoApproval: {
        patterns: [],
        tests: [
          {
            desc: "read_file should be allowed",
            toolUse: { toolName: "read_file" },
            expectedAction: "allow",
            source: "a.json",
          },
        ],
      },
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 1);
  });

  it("matches patterns with input constraints", () => {
    // given:
    const appConfig = /** @type {any} */ ({
      autoApproval: {
        patterns: [
          {
            toolName: "exec_command",
            input: { command: "ls" },
            action: "allow",
            source: "a.json",
          },
        ],
        tests: [
          {
            desc: "ls should be allowed",
            toolUse: { toolName: "exec_command", input: { command: "ls" } },
            expectedAction: "allow",
            source: "a.json",
          },
          {
            desc: "rm should not match",
            toolUse: { toolName: "exec_command", input: { command: "rm" } },
            expectedAction: null,
            source: "a.json",
          },
        ],
      },
    });

    // when:
    const exitCode = runTestApprovalCommand(appConfig);

    // then:
    assert.strictEqual(exitCode, 0);
  });
});
