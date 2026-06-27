import type { EventEmitter } from "node:events";
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

export type Agent = {
  userEventEmitter: UserEventEmitter;
  agentEventEmitter: AgentEventEmitter;
  agentCommands: AgentCommands;
};

export type AgentCommands = {
  getCostSummary: () => CostSummary;
  pauseAutoApprove: () => void;
  /** Subagent currently active for this session, or null. */
  getActiveSubagent: () => { name: string } | null;
  /** Wait for any pending session-state writes to flush to disk. */
  flushSessionPersistence: () => Promise<void>;
};

type UserEventMap = {
  userInput: [(MessageContentText | MessageContentImage)[]];
};

export type UserEventEmitter = EventEmitter<UserEventMap>;

type AgentEventMap = {
  message: [Message];
  partialMessageContent: [PartialMessageContent];
  error: [Error];
  toolUseRequest: [number];
  turnEnd: [];
  providerTokenUsage: [ProviderTokenUsage];
  subagentSwitched: [{ name: string } | null];
};

export type AgentEventEmitter = EventEmitter<AgentEventMap>;

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
};
