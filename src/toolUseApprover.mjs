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
    const maskedInput = maskApprovalInput(toolUse.toolName, toolUse.input);
    const rawToolUseToMatch = {
      toolName: toolUse.toolName,
      input: toolUse.input,
    };
    const maskedToolUseToMatch = {
      toolName: toolUse.toolName,
      input: maskedInput,
    };

    /**
     * @param {ToolUsePattern} pattern
     * @param {{ toolName: string, input: unknown }} toMatch
     * @returns {ToolUseDecision | null}
     */
    function tryPattern(pattern, toMatch) {
      const patternToMatch = {
        toolName: pattern.toolName,
        ...(pattern.input !== undefined && { input: pattern.input }),
      };

      if (!matchValue(toMatch, patternToMatch)) {
        return null;
      }

      const action = pattern.action ?? defaultAction;

      if (!["allow", "deny", "ask"].includes(action)) {
        return { action: "ask" };
      }

      if (action === "deny") {
        return { action: "deny", reason: pattern.reason };
      }

      if (action === "allow") {
        if (isSafeToolInput(maskedInput)) {
          state.approvalCount += 1;
          return state.approvalCount <= max
            ? { action: "allow" }
            : { action: "ask" };
        }
        return { action: defaultAction };
      }

      return { action };
    }

    // User-defined config patterns are matched against the raw input so callers
    // can constrain on any field they want.
    for (const pattern of patterns) {
      const decision = tryPattern(pattern, rawToolUseToMatch);
      if (decision) {
        return decision;
      }
    }

    // In-session approvals are matched against the masked input, treating the
    // mask as an equivalence class (e.g. same origin, same filePath).
    for (const pattern of state.allowedToolUseInSession) {
      const decision = tryPattern(pattern, maskedToolUseToMatch);
      if (decision) {
        return decision;
      }
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
