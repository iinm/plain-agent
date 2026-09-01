/**
 * @import { MessageContentToolUse } from "./model";
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createToolUseApprover } from "./toolUseApprover.mjs";

describe("createToolUseApprover", () => {
  it("should approve allowed tool use up to maxAutoApprovals", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [
        { toolName: "exec_command", input: { command: "ls" }, action: "allow" },
      ],
      maxApprovals: 2,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const allowedToolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "ls" },
    };

    // when/then:
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(allowedToolUse),
      { action: "allow" },
      "should approve on first use",
    );
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(allowedToolUse),
      { action: "allow" },
      "should approve on second use",
    );
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(allowedToolUse),
      {
        action: "ask",
        reason: "Auto-approval limit exceeded (2)",
      },
      "should not approve on third use (exceeds maxApprovals)",
    );

    // when/then:
    toolApprover.resetApprovalCount();
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(allowedToolUse),
      { action: "allow" },
      "should approve on first use after reset",
    );
  });

  it("should not approve disallowed tool use (action: ask by default)", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [
        { toolName: "exec_command", input: { command: "ls" }, action: "allow" },
      ],
      maxApprovals: 2,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const disallowedToolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "rm" },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(disallowedToolUse), {
      action: "ask",
    });
  });

  it("should ask when action is invalid (typo)", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [
        // @ts-expect-error
        { toolName: "exec_command", input: { command: "ls" }, action: "denyy" },
      ],
      maxApprovals: 2,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "ls" },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(toolUse), {
      action: "ask",
    });
  });

  it("should deny tool use when action is deny", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [
        {
          toolName: "exec_command",
          input: { command: "grep" },
          action: "deny",
          reason: "Use rg",
        },
      ],
      maxApprovals: 2,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const deniedToolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "grep" },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(deniedToolUse), {
      action: "deny",
      reason: "Use rg",
    });
  });

  it("should mask input when allowed", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [],
      maxApprovals: 2,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => {
        // ignore content
        const { filePath } = input;
        return { filePath };
      },
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "write_file",
      input: { filePath: "allowed.txt", content: "hello" },
    };

    // when/then:
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(toolUse),
      { action: "ask" },
      "should not approve disallowed tool use",
    );

    // when/then:
    toolApprover.allowToolUse(toolUse);
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(toolUse),
      { action: "allow" },
      "should approve allowed tool use",
    );
  });

  it("should match tool use when pattern.input is undefined", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [
        { toolName: "switch_to_subagent", action: "allow" },
        { toolName: /^switch_to_main_agent$/, action: "allow" },
      ],
      maxApprovals: 5,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const switchToSubagentToolUse = {
      type: "tool_use",
      toolUseId: "test1",
      toolName: "switch_to_subagent",
      input: { name: "researcher", goal: "Find information" },
    };

    /** @type {MessageContentToolUse} */
    const reportToolUse = {
      type: "tool_use",
      toolUseId: "test2",
      toolName: "switch_to_main_agent",
      input: { memoryPath: ".agent/memory/test.md" },
    };

    // when/then:
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(switchToSubagentToolUse),
      { action: "allow" },
      "should approve switch_to_subagent without input pattern",
    );
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(reportToolUse),
      { action: "allow" },
      "should approve switch_to_main_agent without input pattern",
    );
  });

  it("should deny tool use when defaultAction is deny and no pattern matches", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [
        { toolName: "exec_command", input: { command: "ls" }, action: "allow" },
      ],
      maxApprovals: 2,
      defaultAction: "deny",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const unmatchedToolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "rm" },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(unmatchedToolUse), {
      action: "deny",
    });
  });

  it("should deny tool use when a pattern matches but action is undefined and defaultAction is deny", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [{ toolName: "exec_command", input: { command: "ls" } }],
      maxApprovals: 2,
      defaultAction: "deny",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "ls" },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(toolUse), {
      action: "deny",
      reason: undefined,
    });
  });

  it("should fall back to defaultAction with reason when path validation rejects an allowed tool use", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [
        {
          toolName: "exec_command",
          input: { command: "cat" },
          action: "allow",
        },
      ],
      maxApprovals: 2,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "cat", args: [".plain-agent/config.local.json"] },
    };

    // when/then:
    const decision = toolApprover.isAllowedToolUse(toolUse);
    assert.strictEqual(decision.action, "ask");
    assertUnsafePathReason(decision.reason);
  });

  it("should deny with reason when path validation rejects an allowed tool use", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [
        {
          toolName: "exec_command",
          input: { command: "cat" },
          action: "allow",
        },
      ],
      maxApprovals: 2,
      defaultAction: "deny",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "cat", args: ["../parent-file"] },
    };

    // when/then:
    const decision = toolApprover.isAllowedToolUse(toolUse);
    assert.strictEqual(decision.action, "deny");
    assertUnsafePathReason(decision.reason);
  });
  it("should deny with reason when maxApprovals is exceeded and defaultAction is deny", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [
        {
          toolName: "exec_command",
          input: { command: "cat" },
          action: "allow",
        },
      ],
      maxApprovals: 1,
      defaultAction: "deny",
      maskApprovalInput: (_name, input) => input,
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "cat", args: ["README.md"] },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(toolUse), {
      action: "allow",
    });

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(toolUse), {
      action: "deny",
      reason: "Auto-approval limit exceeded (1)",
    });
  });
});

/**
 * @param {string | undefined} reason
 * @returns {void}
 */
function assertUnsafePathReason(reason) {
  assert.match(
    reason ?? "",
    /^Path validation failed: /,
    "decision should carry the path validation failure reason",
  );
}
