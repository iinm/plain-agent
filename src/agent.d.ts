import type { AgentRole } from "./context/loadAgentRoles.mjs";
import type { CostSummary } from "./metrics/costTracker.mjs";
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
  stop: () => void;
  pauseAutoApprove: () => void;
  /** Subagent currently active for this session, or null. */
  getActiveSubagent: () => { name: string } | null;
};

/**
 * Discriminated union of events emitted by the agent, distinguished by the
 * `type` field. Consumed via `Agent["start"]`.
 */
export type AgentEvent = { timestamp: Date } & (
  | {
      type: "session_start";
      sessionFormatVersion: number;
      sessionId: string;
      modelName: string;
      workingDir: string;
      startTime: string;
    }
  | { type: "message"; message: Message }
  | { type: "partial_message_content"; partialContent: PartialMessageContent }
  | { type: "error"; error: Error }
  | { type: "tool_use_request"; toolUseCount: number }
  | { type: "turn_end" }
  | { type: "session_end"; cost: CostSummary }
  | { type: "token_usage"; usage: ProviderTokenUsage }
  | {
      type: "subagent_switched";
      subagent: {
        name: string;
        goal: string;
        switchMessageIndex: number;
      } | null;
    }
  | { type: "messages_reset"; messages: Message[] }
);

/** Sink used by the agent loop to push events onto the output stream. */
export type AgentEventSink = (event: AgentEvent) => void;

export type AgentConfig = {
  callModel: CallModel;
  prompt: string;
  tools: Tool[];
  toolUseApprover: ToolUseApprover;
  agentRoles: Map<string, AgentRole>;
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
  budget?: AgentBudgetConfig;
};

export type AgentBudgetConfig = {
  softLimits: AgentBudget[];
  promptOnSoftLimitExceeded: string;
};

type AgentBudget =
  | {
      type: "time";
      seconds: number;
    }
  | {
      type: "turns";
      turns: number;
    };
