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
      { action: "ask" },
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

  it("should take default action when git-ignored file is specified", () => {
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
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(toolUse), {
      action: "ask",
    });
  });

  it("treats in-session approvals by their masked input (e.g. origin) so equivalent calls match", () => {
    // given:
    const toolApprover = createToolUseApprover({
      patterns: [],
      maxApprovals: 5,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => {
        // Pretend this is the web_fetch origin mask.
        const url = /** @type {{url: string}} */ (input).url ?? "";
        const m = url.match(/^(https?:\/\/[^/]+)/);
        return { url: m ? m[1] : "" };
      },
    });

    /** @type {MessageContentToolUse} */
    const firstUse = {
      type: "tool_use",
      toolUseId: "1",
      toolName: "web_fetch",
      input: { url: "https://example.com/foo", question: "?" },
    };
    /** @type {MessageContentToolUse} */
    const sameOriginDifferentPath = {
      type: "tool_use",
      toolUseId: "2",
      toolName: "web_fetch",
      input: { url: "https://example.com/bar?x=1", question: "?" },
    };
    /** @type {MessageContentToolUse} */
    const differentOrigin = {
      type: "tool_use",
      toolUseId: "3",
      toolName: "web_fetch",
      input: { url: "https://evil.example.org/foo", question: "?" },
    };

    // when:
    toolApprover.allowToolUse(firstUse);

    // then:
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(firstUse), {
      action: "allow",
    });
    assert.deepStrictEqual(
      toolApprover.isAllowedToolUse(sameOriginDifferentPath),
      { action: "allow" },
      "different path on same origin should reuse the approval",
    );
    assert.deepStrictEqual(toolApprover.isAllowedToolUse(differentOrigin), {
      action: "ask",
    });
  });

  it("snapshots and restores allowed tool-use patterns", () => {
    // given:
    const a = createToolUseApprover({
      patterns: [],
      maxApprovals: 5,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => input,
    });
    /** @type {MessageContentToolUse} */
    const toolUse = {
      type: "tool_use",
      toolUseId: "1",
      toolName: "exec_command",
      input: { command: "ls" },
    };
    a.allowToolUse(toolUse);

    // when:
    const snapshot = a.getAllowedToolUseInSession();
    const b = createToolUseApprover({
      patterns: [],
      maxApprovals: 5,
      defaultAction: "ask",
      maskApprovalInput: (_name, input) => input,
    });
    b.restoreAllowedToolUseInSession(snapshot);

    // then:
    assert.deepStrictEqual(b.isAllowedToolUse(toolUse), { action: "allow" });
  });
});
