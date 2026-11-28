/**
 * @import { ToolUseApprover, ToolUseApproverConfig, ToolUseDecision, ToolUsePattern } from './tool'
 * @import { FileTarget } from "./fileAccess.mjs"
 * @import { ResolvedToolPath } from "./toolInputValidator.mjs"
 * @import { MessageContentToolUse } from './model'
 */

import {
  findUnsafeResolvedToolPath,
  findUnsafeToolInput,
} from "./toolInputValidator.mjs";
import { matchValue } from "./utils/matchValue.mjs";
import { noThrow } from "./utils/noThrow.mjs";

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
  resolveFileTarget,
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
   * @returns {Promise<ToolUseDecision>}
   */
  async function isAllowedToolUse(toolUse) {
    const ruleDecision = decideApprovalRule(toolUse);
    if (ruleDecision?.action === "deny") return ruleDecision;

    const target = await noThrow(async () => resolveFileTarget?.(toolUse));
    if (target instanceof Error) {
      return {
        action: defaultAction,
        reason: target.message,
      };
    }

    if (ruleDecision) {
      return target
        ? {
            ...ruleDecision,
            path: { input: target.inputPath, resolved: target.realPath },
          }
        : ruleDecision;
    }

    return decideAllow(toolUse, true, target);
  }

  /**
   * @param {string} filePath
   * @param {ResolvedToolPath} [target]
   */
  function canAutoApproveFileRead(filePath, target) {
    const toolUse = { toolName: "read_file", input: { filePath } };
    const decision =
      decideApprovalRule(toolUse) ??
      decideAllow(toolUse, false, target && { ...target, inputPath: filePath });
    return decision.action === "allow";
  }

  /**
   * Return a final decision for denied, unmatched or manual rules. A matching
   * allow rule still requires validation and an available approval.
   * @param {Pick<MessageContentToolUse, "toolName" | "input">} toolUse
   * @returns {ToolUseDecision | undefined}
   */
  function decideApprovalRule(toolUse) {
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

      if (action === "allow") return undefined;

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
   * @param {Pick<MessageContentToolUse, "toolName" | "input">} toolUse
   * @param {boolean} consumeApproval
   * @param {FileTarget} [fileTarget]
   * @returns {ToolUseDecision}
   */
  function decideAllow(toolUse, consumeApproval, fileTarget) {
    const maskedInput = maskApprovalInput(toolUse.toolName, toolUse.input);
    const failure = fileTarget
      ? findUnsafeResolvedToolPath(
          fileTarget.inputPath,
          fileTarget,
          allowedPaths,
          allowGitUnmanagedFiles,
        )
      : shouldSkipPathValidation(toolUse.toolName, toolUse.input)
        ? undefined
        : findUnsafeToolInput(
            maskedInput,
            allowedPaths,
            allowGitUnmanagedFiles,
          );
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

    const nextApprovalCount = state.approvalCount + 1;
    if (nextApprovalCount <= max) {
      if (consumeApproval) state.approvalCount = nextApprovalCount;
      return { action: "allow" };
    }
    return {
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
    canAutoApproveFileRead,
    resetApprovalCount,
  };
}
