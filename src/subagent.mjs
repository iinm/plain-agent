/**
 * @import { Message, MessageContentToolResult, MessageContentToolUse } from "./model"
 * @import { SwitchToMainAgentInput } from "./tools/switchToMainAgent"
 * @import { AgentRole } from "./context/loadAgentRoles.mjs"
 * @import { Marker } from "./agentState.mjs"
 * @import { SubagentSerializedState } from "./sessionStore.mjs"
 */

import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_PROJECT_METADATA_DIR } from "./env.mjs";
import { CLAUDE_CODE_COMPATIBILITY_NOTES } from "./prompt.mjs";
import { switchToMainAgentToolName } from "./tools/switchToMainAgent.mjs";

/** @typedef {ReturnType<typeof createSubagentManager>} SubagentManager */

/**
 * @typedef {Object} SubagentStateEventHandlers
 * @property {(subagent: {name:string} | null) => void} onSubagentSwitched
 */

/**
 * Creates a manager for subagent lifecycle and state.
 * @param {Map<string, AgentRole>} agentRoles
 * @param {SubagentStateEventHandlers} handlers
 */
export function createSubagentManager(agentRoles, handlers) {
  /** @type {{name: string; goal: string; checkpoint: Marker}[]} */
  const subagents = [];
  let subagentCount = 0;

  /**
   * @typedef {SwitchToSubagentSuccess | SwitchToSubagentFailure} SwitchToSubagentResult
   */

  /**
   * @typedef {Object} SwitchToSubagentSuccess
   * @property {true} success
   * @property {string} value
   */

  /**
   * @typedef {Object} SwitchToSubagentFailure
   * @property {false} success
   * @property {string} error
   */

  /**
   * Switch to a subagent role.
   * @param {string} name
   * @param {string} goal
   * @param {() => Marker} createCheckpoint - Factory for the marker to restore
   *   to on report. Invoked only once the switch is known to proceed, so a
   *   rejected switch never leaves an abandoned checkpoint behind.
   * @returns {SwitchToSubagentResult}
   */
  function switchToSubagent(name, goal, createCheckpoint) {
    if (subagents.length > 0) {
      return {
        success: false,
        error:
          "Cannot call switch_to_subagent while already acting as a subagent.",
      };
    }

    const isCustomRole = name.startsWith("custom:");
    const actualName = isCustomRole ? name.substring(7) : name;

    let roleContent = "";
    if (!isCustomRole) {
      const role = agentRoles.get(name);
      if (!role) {
        const availableRoles = Array.from(agentRoles.keys())
          .sort()
          .map((id) => `  - ${id}`)
          .join("\n");
        return {
          success: false,
          error: `Agent role "${name}" not found. Available agent roles:\n${availableRoles}\n\nTo use an ad-hoc role, prefix the name with "custom:" (e.g., "custom:researcher").`,
        };
      }
      roleContent = role.claudeOriginated
        ? `${role.content}\n\n---\n\n${CLAUDE_CODE_COMPATIBILITY_NOTES}`
        : role.content;
    }

    subagentCount++;
    const sequenceNumber = String(subagentCount).padStart(2, "0");

    subagents.push({
      name: actualName,
      goal,
      checkpoint: createCheckpoint(),
    });
    handlers.onSubagentSwitched({ name: actualName });

    return {
      success: true,
      value: [
        `[SUBAGENT MODE ACTIVATED] You are now operating as the subagent "${actualName}".`,
        roleContent
          ? `Role: ${actualName}\n---\n${roleContent}\n---`
          : `Role: ${actualName}`,
        `Your goal: ${goal}`,
        `Memory file path format: ${AGENT_PROJECT_METADATA_DIR}/memory/<session-id>--${sequenceNumber}--${actualName.replace("/", "-")}--<kebab-case-title>.md (Replace <kebab-case-title> with a short title describing your own goal)`,
        `When finished, call "switch_to_main_agent" with the memory file path. Start executing your goal now.`,
      ].join("\n\n"),
    };
  }

  /**
   * @typedef {SwitchToMainAgentSuccess | SwitchToMainAgentFailure} SwitchToMainAgentResult
   */

  /**
   * @typedef {Object} SwitchToMainAgentSuccess
   * @property {true} success
   * @property {string} memoryContent
   */

  /**
   * @typedef {Object} SwitchToMainAgentFailure
   * @property {false} success
   * @property {string} error
   */

  /**
   * Switch back to the main agent role and read the memory file.
   * @param {string} memoryPath
   * @returns {Promise<SwitchToMainAgentResult>}
   */
  async function switchToMainAgent(memoryPath) {
    if (subagents.length === 0) {
      return {
        success: false,
        error: "Cannot call switch_to_main_agent from the main agent.",
      };
    }

    const absolutePath = path.resolve(memoryPath);
    const memoryDir = path.resolve(AGENT_PROJECT_METADATA_DIR, "memory");
    const relativePath = path.relative(memoryDir, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return {
        success: false,
        error: `Access denied: memoryPath must be within ${AGENT_PROJECT_METADATA_DIR}/memory`,
      };
    }

    try {
      const memoryContent = await fs.readFile(absolutePath, {
        encoding: "utf-8",
      });
      return {
        success: true,
        memoryContent: memoryContent,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read memory file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * @typedef {Object} ProcessToolResultsOutcome
   * @property {Marker | null} marker - Checkpoint to truncate the history back
   *   to, or null when no truncation is required.
   * @property {Message | null} newMessage - The user message to add, or null
   *   when tool results should be appended directly.
   */

  /**
   * Process tool results and decide how the message history should change,
   * without touching the message array itself. When a subagent reports back,
   * returns the checkpoint marker to restore to and the report message to add.
   * @param {MessageContentToolUse[]} toolUseParts
   * @param {MessageContentToolResult[]} toolResults
   * @returns {ProcessToolResultsOutcome}
   */
  function processToolResults(toolUseParts, toolResults) {
    const reportSubagentToolUse = toolUseParts.find(
      (toolUse) => toolUse.toolName === switchToMainAgentToolName,
    );

    if (reportSubagentToolUse) {
      const reportResult = toolResults.find(
        (res) => res.toolUseId === reportSubagentToolUse.toolUseId,
      );
      if (!reportResult) {
        return { marker: null, newMessage: null };
      }
      return handleSubagentReport(reportSubagentToolUse, reportResult);
    }

    return { marker: null, newMessage: null };
  }

  /**
   * Handle the result of a subagent reporting back.
   * On success, returns the checkpoint to restore the conversation to and the
   * report converted into a standard user message. Does not mutate the history.
   * @param {MessageContentToolUse} reportToolUse
   * @param {MessageContentToolResult} reportResult
   * @returns {ProcessToolResultsOutcome}
   */
  function handleSubagentReport(reportToolUse, reportResult) {
    if (reportResult.isError) {
      return { marker: null, newMessage: null };
    }

    const currentSubagent = subagents.pop();
    if (!currentSubagent) {
      return { marker: null, newMessage: null };
    }

    handlers.onSubagentSwitched(subagents.at(-1) ?? null);

    // Convert the tool result into a standard user message
    const resultText = reportResult.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n\n");

    const reportInput = /** @type {SwitchToMainAgentInput} */ (
      reportToolUse.input
    );

    /** @type {import('./model').UserMessage} */
    const newMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            `The subagent "${currentSubagent.name}" has completed the task.`,
            `Goal: ${currentSubagent.goal}`,
            `Memory file: ${reportInput.memoryPath}`,
            `Result:\n${resultText}`,
          ].join("\n\n"),
        },
      ],
    };

    return { marker: currentSubagent.checkpoint, newMessage };
  }

  /**
   * Whether the main agent is currently running as a subagent.
   * @returns {boolean}
   */
  function isSubagentActive() {
    return subagents.length > 0;
  }

  /**
   * Get the most recently activated subagent, or null if none is active.
   * @returns {{name: string} | null}
   */
  function getActiveSubagent() {
    const top = subagents.at(-1);
    return top ? { name: top.name } : null;
  }

  /**
   * Snapshot the subagent stack for persistence. The opaque in-memory checkpoint
   * markers are converted to their serializable form via the supplied resolver
   * so this module never sees the on-disk index representation.
   * @param {(marker: Marker) => number} serializeMarker
   * @returns {SubagentSerializedState}
   */
  function getState(serializeMarker) {
    return {
      subagents: subagents.map((s) => ({
        name: s.name,
        goal: s.goal,
        switchMessageIndex: serializeMarker(s.checkpoint),
      })),
      subagentCount,
    };
  }

  /**
   * Restore the subagent stack from a previously saved snapshot. The persisted
   * index for each subagent is turned back into an opaque marker via the
   * supplied reviver. Does NOT fire onSubagentSwitched; the caller is
   * responsible for syncing any UI state (since listeners may not be attached
   * yet).
   * @param {SubagentSerializedState} state
   * @param {(index: number) => Marker} reviveMarker
   */
  function restoreState(state, reviveMarker) {
    if (typeof state !== "object" || state === null) {
      throw new TypeError("state must be a non-null object");
    }
    if (!Array.isArray(state.subagents)) {
      throw new TypeError("state.subagents must be an array");
    }
    if (typeof state.subagentCount !== "number") {
      throw new TypeError("state.subagentCount must be a number");
    }
    subagents.length = 0;
    for (const s of state.subagents) {
      subagents.push({
        name: s.name,
        goal: s.goal,
        checkpoint: reviveMarker(s.switchMessageIndex),
      });
    }
    subagentCount = state.subagentCount;
  }

  return {
    switchToSubagent,
    switchToMainAgent,
    processToolResults,
    isSubagentActive,
    getActiveSubagent,
    getState,
    restoreState,
  };
}
