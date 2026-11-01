/**
 * @import { ToolUseApprover, ToolUseApproverConfig, ToolUseDecision, ToolUsePattern } from './tool'
 * @import { MessageContentToolUse } from './model'
 */

import { findUnsafeToolInputReason } from "./toolInputValidator.mjs";
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
    const allowedInSession = state.allowedToolUseInSession.some((pattern) =>
      matchesToolUse(toolUse.toolName, maskedInput, pattern),
    );

    // Config patterns match the raw input; only session approvals use the mask.
    for (const pattern of patterns) {
      if (!matchesToolUse(toolUse.toolName, toolUse.input, pattern)) {
        continue;
      }

      const action = pattern.action ?? defaultAction;

      if (!["allow", "deny", "ask"].includes(action)) {
        return {
          action: defaultAction,
        };
      }

      if (action === "deny") {
        return {
          action: "deny",
          reason: pattern.reason,
        };
      }

      if (action === "allow") {
        return decideAllow(toolUse, maskedInput, allowedInSession);
      }

      return { action };
    }

    if (allowedInSession) {
      return decideAllow(toolUse, maskedInput, true);
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
   * @param {MessageContentToolUse} toolUse
   * @param {Record<string, unknown>} maskedInput
   * @param {boolean} allowedInSession
   * @returns {ToolUseDecision}
   */
  function decideAllow(toolUse, maskedInput, allowedInSession) {
    const unsafeReason = shouldSkipPathValidation(
      toolUse.toolName,
      toolUse.input,
    )
      ? undefined
      : findUnsafeToolInputReason(
          maskedInput,
          allowedPaths,
          allowGitUnmanagedFiles,
        );
    if (unsafeReason !== undefined) {
      return {
        action: defaultAction,
        reason: `Path validation failed: ${unsafeReason}`,
      };
    }

    // A session approval already covers everything `maskedInput` can reveal,
    // so the blocker would only repeat what the user just confirmed.
    if (!allowedInSession) {
      const blocker = findAutoApprovalBlocker(toolUse.toolName, maskedInput);
      if (blocker !== undefined) {
        return { action: defaultAction, reason: blocker };
      }
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
    allowToolUse,
    resetApprovalCount,
  };
}
