import type { AgentRole } from "./context/loadAgentRoles.mjs";
import type { CostConfig, CostSummary } from "./costTracker.mjs";
import type {
  CallModel,
  Message,
  MessageContentImage,
  MessageContentText,
  PartialMessageContent,
  ProviderTokenUsage,
} from "./model";
import type { SessionState } from "./sessionStore.mjs";
import type { Tool, ToolUseApprover } from "./tool";

export type AgentInput = (MessageContentText | MessageContentImage)[];

export type Agent = {
  /**
   * Start the agent loop and return the async event stream. Consume with
   * `for await`. Also kicks off the internal input queue consumer; call
   * exactly once per session.
   */
  start: () => AsyncIterable<AgentEvent>;
  /**
   * Send user input to the agent. Input is pushed onto an internal async
   * queue and consumed by the agent loop; may be called from multiple places
   * (plain input, slash commands, tool approval).
   */
  send: (input: AgentInput) => void;
  getCostSummary: () => CostSummary;
  pauseAutoApprove: () => void;
  /** Subagent currently active for this session, or null. */
  getActiveSubagent: () => { name: string } | null;
  /**
   * Wait for any pending session-state writes to flush to disk.
   * Resolves to whether the session has ever been persisted (false for
   * empty sessions that were never written).
   */
  flushSessionPersistence: () => Promise<boolean>;
};

/**
 * Discriminated union of events emitted by the agent, distinguished by the
 * `type` field. Consumed via `Agent["start"]`.
 */
export type AgentEvent =
  | { type: "message"; message: Message }
  | { type: "partialMessageContent"; partialContent: PartialMessageContent }
  | { type: "error"; error: Error }
  | { type: "toolUseRequest"; toolUseCount: number }
  | { type: "turnEnd" }
  | { type: "providerTokenUsage"; usage: ProviderTokenUsage }
  | { type: "subagentSwitched"; subagent: { name: string } | null };

/** Sink used by the agent loop to push events onto the output stream. */
export type AgentEventSink = (event: AgentEvent) => void;

export type AgentConfig = {
  callModel: CallModel;
  prompt: string;
  tools: Tool[];
  toolUseApprover: ToolUseApprover;
  agentRoles: Map<string, AgentRole>;
  modelCostConfig?: CostConfig;
  /** Metadata used when persisting session state. */
  sessionMetadata: {
    sessionId: string;
    modelName: string;
    workingDir: string;
    startTime: Date;
  };
  /** When provided, the agent restores its state from this snapshot. */
  initialState?: SessionState | null;
  /** Soft limit on input tokens; triggers auto-compact prompt when exceeded. */
  contextSoftLimit?: number;
  /** Keys in providerTokenUsage to sum for input token count. */
  inputTokensKeys?: string[];
};
