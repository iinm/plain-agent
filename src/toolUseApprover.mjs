/**
 * @import { ToolUseApprover, ToolUseApproverConfig, ToolUseDecision, ToolUsePattern } from './tool'
 * @import { MessageContentToolUse } from './model'
 */

import { findUnsafeToolInput } from "./toolInputValidator.mjs";
import { matchValue } from "./utils/matchValue.mjs";

/**
 * @param {ToolUseApproverConfig} config
 * @returns {ToolUseApprover}
 */
export function createToolUseApprover({
  patterns,
  maxApprovals: max,
  defaultAction,
  maskApprovalInput,
  findAutoApprovalBlocker = () => undefined,
  allowedPaths = [],
  allowGitUnmanagedFiles = false,
  shouldSkipPathValidation = () => false,
}) {
  const state = {
    approvalCount: 0,
  };

  /** @returns {void} */
  function resetApprovalCount() {
    state.approvalCount = 0;
  }

  /**
   * @param {MessageContentToolUse} toolUse
   * @returns {ToolUseDecision}
   */
  function isAllowedToolUse(toolUse) {
    for (const pattern of patterns) {
      if (!matchesToolUse(toolUse.toolName, toolUse.input, pattern)) {
        continue;
      }

      const action = pattern.action ?? defaultAction;

      if (!["allow", "deny", "ask"].includes(action)) {
        return defaultAction === "ask"
          ? {
              action: "ask",
              reason:
                "Matched approval rule has an invalid action (default action is ask)",
            }
          : { action: defaultAction };
      }

      if (action === "deny") {
        return {
          action: "deny",
          reason: pattern.reason,
        };
      }

      if (action === "allow") {
        return decideAllow(toolUse);
      }

      return {
        action: "ask",
        reason:
          pattern.reason ||
          (pattern.action === "ask"
            ? 'Matched approval rule with action "ask"'
            : 'Matched approval rule uses the default action "ask"'),
      };
    }

    return defaultAction === "ask"
      ? {
          action: "ask",
          reason: 'No approval rule matched (default action is "ask")',
        }
      : { action: defaultAction };
  }

  /**
   * @param {MessageContentToolUse} toolUse
   * @returns {ToolUseDecision}
   */
  function decideAllow(toolUse) {
    const maskedInput = maskApprovalInput(toolUse.toolName, toolUse.input);
    const failure = shouldSkipPathValidation(toolUse.toolName, toolUse.input)
      ? undefined
      : findUnsafeToolInput(maskedInput, allowedPaths, allowGitUnmanagedFiles);
    if (failure !== undefined) {
      const reason = `Path validation failed: ${failure.reason}`;
      if (defaultAction === "ask") {
        return { action: "ask", reason, path: failure.path };
      }
      return {
        action: defaultAction,
        reason: failure.path ? `${reason}: ${failure.path.input}` : reason,
      };
    }

    const blocker = findAutoApprovalBlocker(toolUse.toolName, maskedInput);
    if (blocker !== undefined) {
      return { action: defaultAction, reason: blocker };
    }

    state.approvalCount += 1;
    return state.approvalCount <= max
      ? { action: "allow" }
      : {
          action: defaultAction,
          reason: `Auto-approval limit exceeded (${max})`,
        };
  }

  /**
   * @param {string} toolName
   * @param {Record<string, unknown>} input
   * @param {ToolUsePattern} pattern
   * @returns {boolean}
   */
  function matchesToolUse(toolName, input, pattern) {
    return matchValue(
      { toolName, input },
      {
        toolName: pattern.toolName,
        ...(pattern.input !== undefined && { input: pattern.input }),
      },
    );
  }
  return {
    isAllowedToolUse,
    resetApprovalCount,
  };
}
