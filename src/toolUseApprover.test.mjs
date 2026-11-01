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

  it("should fallback to default action when action is invalid (typo)", () => {
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

  it("should skip path validation when shouldSkipPathValidation returns true", () => {
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
      shouldSkipPathValidation: (toolName) => toolName === "exec_command",
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "exec_command",
      input: { command: "cat", args: ["../parent-file"] },
    };

    // when/then:
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(toolUse),
      { action: "allow" },
      "should allow despite an unsafe path when validation is skipped",
    );
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

  it("should fall back to ask with the blocker reason when an allow pattern matches", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [{ toolName: "web_fetch", action: "allow" }],
      maxApprovals: 2,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => ({ url: String(input.url) }),
      findAutoApprovalBlocker: (_name, input) =>
        input.url === "https://example.com"
          ? undefined
          : `Blocked by allowedDomains: \`${String(input.url)}\` is not in the allow list.`,
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "web_fetch",
      input: { url: "https://other.com/a", question: "?" },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(toolUse), {
      action: "ask",
      reason:
        "Blocked by allowedDomains: `https://other.com/a` is not in the allow list.",
    });
  });

  it("should fall back to deny with the blocker reason when defaultAction is deny", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [{ toolName: "web_fetch", action: "allow" }],
      maxApprovals: 2,
      defaultAction: "deny",
      maskApprovalInput: (_name, input) => ({ url: String(input.url) }),
      findAutoApprovalBlocker: () => "Blocked by test",
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "web_fetch",
      input: { url: "https://other.com/a", question: "?" },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(toolUse), {
      action: "deny",
      reason: "Blocked by test",
    });
  });

  it("should allow when the blocker returns undefined", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [{ toolName: "web_fetch", action: "allow" }],
      maxApprovals: 2,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => ({ url: String(input.url) }),
      findAutoApprovalBlocker: () => undefined,
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "web_fetch",
      input: { url: "https://example.com/a", question: "?" },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(toolUse), {
      action: "allow",
    });
  });

  it("should not consume maxApprovals when a blocker downgrades the decision", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [{ toolName: "web_fetch", action: "allow" }],
      maxApprovals: 1,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => ({ url: String(input.url) }),
      findAutoApprovalBlocker: (_name, input) =>
        input.url === "https://blocked.com" ? "Blocked by test" : undefined,
    });

    /** @param {string} url @returns {MessageContentToolUse} */
    const makeToolUse = (url) => ({
      type: "tool_use",
      toolUseId: "test",
      toolName: "web_fetch",
      input: { url, question: "?" },
    });

    // when:
    const blocked = toolApprover.isAllowedToolUse(
      makeToolUse("https://blocked.com"),
    );
    const allowed = toolApprover.isAllowedToolUse(
      makeToolUse("https://ok.com"),
    );
    const exceeded = toolApprover.isAllowedToolUse(
      makeToolUse("https://ok.com"),
    );

    // then:
    assert.deepStrictEqual(blocked, {
      action: "ask",
      reason: "Blocked by test",
    });
    assert.deepStrictEqual(allowed, { action: "allow" });
    assert.deepStrictEqual(exceeded, {
      action: "ask",
      reason: "Auto-approval limit exceeded (1)",
    });
  });

  it("should not call the blocker when a deny pattern matches", () => {
    // given:
    let blockerCalls = 0;
    const toolApprover = createToolUseApprover({
      patterns: [
        {
          toolName: "web_fetch",
          input: { url: "https://other.com" },
          action: "deny",
          reason: "nope",
        },
      ],
      maxApprovals: 2,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => ({ url: String(input.url) }),
      findAutoApprovalBlocker: () => {
        blockerCalls += 1;
        return "Blocked by test";
      },
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "web_fetch",
      input: { url: "https://other.com", question: "?" },
    };

    // when:
    const decision = toolApprover.isAllowedToolUse(toolUse);

    // then:
    assert.deepStrictEqual(decision, { action: "deny", reason: "nope" });
    assert.equal(blockerCalls, 0);
  });

  it("should match config patterns against the raw input, not the masked input", () => {
    // given: the mask drops `question`, which the config pattern requires.
    const toolApprover = createToolUseApprover({
      patterns: [
        {
          toolName: "web_fetch",
          input: { question: "?" },
          action: "allow",
        },
      ],
      maxApprovals: 2,
      defaultAction: "deny",
      maskApprovalInput: (_name, input) => ({ url: String(input.url) }),
    });

    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "test",
      toolName: "web_fetch",
      input: { url: "https://example.com/a", question: "?" },
    };

    // when/then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(toolUse), {
      action: "allow",
    });
  });

  it("should match an in-session approval against the masked input", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [],
      maxApprovals: 5,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => ({
        url: new URL(String(input.url)).origin,
      }),
    });

    /** @param {string} url @returns {MessageContentToolUse} */
    const makeToolUse = (url) => ({
      type: "tool_use",
      toolUseId: "test",
      toolName: "web_fetch",
      input: { url, question: "?" },
    });

    // when/then:
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(makeToolUse("https://other.com/a")),
      { action: "ask" },
    );
    toolApprover.allowToolUse(makeToolUse("https://other.com/a"));
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(makeToolUse("https://other.com/b")),
      { action: "allow" },
    );
  });

  it("should skip the blocker when the same masked input was approved in this session", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [{ toolName: "web_fetch", action: "allow" }],
      maxApprovals: 5,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => ({
        url: new URL(String(input.url)).origin,
      }),
      findAutoApprovalBlocker: () => "Blocked by test",
    });

    /** @param {string} url @returns {MessageContentToolUse} */
    const makeToolUse = (url) => ({
      type: "tool_use",
      toolUseId: "test",
      toolName: "web_fetch",
      input: { url, question: "?" },
    });

    // when/then:
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(makeToolUse("https://other.com/a")),
      { action: "ask", reason: "Blocked by test" },
    );
    toolApprover.allowToolUse(makeToolUse("https://other.com/a"));
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(makeToolUse("https://other.com/b")),
      { action: "allow" },
    );
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
