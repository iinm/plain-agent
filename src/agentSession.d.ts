import type {
  Agent,
  AgentBudgetConfig,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "./agent";
import type { AgentRole } from "./context/loadAgentRoles.mjs";
import type { CallModel } from "./model";
import type { SessionState } from "./sessionStore.mjs";
import type { Tool, ToolUseApprover } from "./tool";

export type AgentSessionOptions = {
  callModel: CallModel;
  /** System prompt. Defaults to a minimal prompt. */
  prompt?: string;
  tools?: Tool[];
  agentRoles?: Map<string, AgentRole>;
  /**
   * Policy deciding allow/deny/ask for each tool call. Defaults to asking for
   * every call, so provide `requestToolApproval` or a pattern-based approver
   * such as `createToolUseApprover` to allow calls.
   */
  toolUseApprover?: ToolUseApprover;
  /**
   * Called when the policy returns `ask` or auto-approval was paused. When
   * omitted, the loop emits `tool_use_request` and waits for the next `send()`.
   */
  requestToolApproval?: (
    request: ToolApprovalRequest,
  ) => Promise<ToolApprovalDecision>;
  sessionId?: string;
  modelName?: string;
  cwd?: string;
  startTime?: Date;
  initialState?: SessionState | null;
  contextSoftLimit?: number;
  inputTokensKeys?: string[];
  budget?: AgentBudgetConfig;
};

/**
 * Create an agent session. Library-friendly front-end for `createAgent`.
 */
export function createAgentSession(options: AgentSessionOptions): Agent;
