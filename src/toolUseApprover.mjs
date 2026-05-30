/**
 * @import { ToolUseApprover, ToolUseApproverConfig, ToolUseDecision, ToolUsePattern } from './tool'
 * @import { MessageContentToolUse } from './model'
 */

import { isSafeToolInput } from "./toolInputValidator.mjs";
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
  allowedPaths = [],
  allowGitIgnoredFiles = false,
}) {
  const state = {
    approvalCount: 0,
    /** @type {ToolUsePattern[]} */
    allowedToolUseInSession: [],
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
    const toolUseToMatch = {
      toolName: toolUse.toolName,
      input: toolUse.input,
    };

    for (const pattern of [...patterns, ...state.allowedToolUseInSession]) {
      const patternToMatch = {
        toolName: pattern.toolName,
        ...(pattern.input !== undefined && { input: pattern.input }),
      };

      if (!matchValue(toolUseToMatch, patternToMatch)) {
        continue;
      }

      const action = pattern.action ?? defaultAction;

      if (!["allow", "deny", "ask"].includes(action)) {
        return {
          action: "ask",
        };
      }

      if (action === "deny") {
        return {
          action: "deny",
          reason: pattern.reason,
        };
      }

      if (action === "allow") {
        const maskedInput = maskApprovalInput(toolUse.toolName, toolUse.input);
        if (isSafeToolInput(maskedInput, allowedPaths, allowGitIgnoredFiles)) {
          state.approvalCount += 1;
          return state.approvalCount <= max
            ? { action: "allow" }
            : { action: "ask" };
        }
        return { action: defaultAction };
      }

      return { action };
    }

    return { action: defaultAction };
  }

  /**
   * @param {MessageContentToolUse} toolUse
   * @returns {void}
   */
  function allowToolUse(toolUse) {
    state.allowedToolUseInSession.push({
      toolName: toolUse.toolName,
      input: maskApprovalInput(toolUse.toolName, toolUse.input),
      action: "allow",
    });
  }

  /**
   * Snapshot the tool-use patterns the user explicitly allowed during this
   * session. Used to persist resumable session state.
   * @returns {ToolUsePattern[]}
   */
  function getAllowedToolUseInSession() {
    return state.allowedToolUseInSession.map((p) => ({ ...p }));
  }

  /**
   * Replace the in-session allow-list with a previously saved snapshot.
   * @param {ToolUsePattern[]} patterns
   */
  function restoreAllowedToolUseInSession(patterns) {
    if (!Array.isArray(patterns)) {
      throw new TypeError("patterns must be an array");
    }
    state.allowedToolUseInSession.length = 0;
    for (const p of patterns) {
      state.allowedToolUseInSession.push({ ...p });
    }
  }

  return {
    isAllowedToolUse,
    allowToolUse,
    resetApprovalCount,
    getAllowedToolUseInSession,
    restoreAllowedToolUseInSession,
  };
}
