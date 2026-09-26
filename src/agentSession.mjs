/**
 * @import { Agent, AgentBudgetConfig, ToolApprovalDecision, ToolApprovalRequest } from "./agent"
 * @import { ValuePattern } from "./utils/matchValue"
 * @import { Tool, ToolUseApprover } from "./tool"
 * @import { CallModel } from "./model"
 * @import { AgentRole } from "./context/loadAgentRoles.mjs"
 * @import { SessionState } from "./sessionStore.mjs"
 */

import { createAgent } from "./agent.mjs";
import { matchValue } from "./utils/matchValue.mjs";
import { generateSessionId } from "./utils/sessionId.mjs";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

/**
 * @typedef {object} AgentSessionOptions
 * @property {CallModel} callModel
 * @property {string} [prompt] - System prompt. Defaults to a minimal prompt.
 * @property {Tool[]} [tools]
 * @property {Map<string, AgentRole>} [agentRoles]
 * @property {ToolUseApprover} [toolUseApprover] - Policy deciding allow/deny/ask for each tool call. Defaults to asking for every call, so provide `requestToolApproval` or a pattern-based approver such as `createToolUseApprover` to allow calls.
 * @property {(request: ToolApprovalRequest) => Promise<ToolApprovalDecision>} [requestToolApproval] - Asked when the policy returns `ask` or auto-approval was paused. When omitted, the loop emits `tool_use_request` and waits for the next `send()`.
 * @property {string} [sessionId]
 * @property {string} [modelName]
 * @property {string} [cwd]
 * @property {Date} [startTime]
 * @property {SessionState | null} [initialState]
 * @property {number} [contextSoftLimit]
 * @property {string[]} [inputTokensKeys]
 * @property {AgentBudgetConfig} [budget]
 */

/**
 * Create an agent session. Library-friendly front-end for `createAgent`:
 * session metadata is derived from `sessionId` / `modelName` / `cwd`, and tool
 * calls require approval by default.
 *
 * @param {AgentSessionOptions} options
 * @returns {Agent}
 */
export function createAgentSession({
  callModel,
  prompt = DEFAULT_SYSTEM_PROMPT,
  tools = [],
  agentRoles = new Map(),
  toolUseApprover = createAskApprover(),
  requestToolApproval,
  sessionId = generateSessionId(),
  modelName = "unknown",
  cwd = process.cwd(),
  startTime = new Date(),
  initialState = null,
  contextSoftLimit,
  inputTokensKeys,
  budget,
}) {
  return createAgent({
    callModel,
    prompt,
    tools,
    toolUseApprover,
    agentRoles,
    requestToolApproval,
    sessionMetadata: { sessionId, modelName, workingDir: cwd, startTime },
    initialState,
    contextSoftLimit,
    inputTokensKeys,
    budget,
  });
}

/** @returns {ToolUseApprover} */
function createAskApprover() {
  /** @type {unknown[]} */
  const sessionAllowed = [];

  return {
    isAllowedToolUse: (toolUse) =>
      sessionAllowed.some((pattern) =>
        matchValue(
          { toolName: toolUse.toolName, input: toolUse.input },
          /** @type {ValuePattern} */ (pattern),
        ),
      )
        ? { action: "allow" }
        : { action: "ask" },
    allowToolUse: (toolUse) => {
      sessionAllowed.push({ toolName: toolUse.toolName, input: toolUse.input });
    },
    resetApprovalCount: () => {},
  };
}
