/* Model Configuration */
export type BedrockConverseModelConfig = {
  model: string;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  };
  additionalModelRequestFields?: Record<string, unknown>;
  enablePromptCaching?: boolean;
};

/* Request */
export type BedrockConverseRequest = {
  modelId?: string;
  messages: BedrockMessage[];
  system?: BedrockSystemContentBlock[];
  toolConfig?: BedrockToolConfig;
  additionalModelRequestFields?: Record<string, unknown>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
  };
};

/* Message */
export type BedrockMessage = BedrockUserMessage | BedrockAssistantMessage;

export type BedrockUserMessage = {
  role: "user";
  content: BedrockContentBlock[];
};

export type BedrockAssistantMessage = {
  role: "assistant";
  content: BedrockAssistantContentBlock[];
};

export type BedrockSystemContentBlock =
  | {
      text: string;
    }
  | BedrockCachePointBlock;

/* Content Block */
export type BedrockContentBlock =
  | BedrockTextBlock
  | BedrockImageBlock
  | BedrockToolUseBlock
  | BedrockToolResultBlock
  | BedrockCachePointBlock;

export type BedrockAssistantContentBlock =
  | BedrockTextBlock
  | BedrockToolUseBlock
  | BedrockReasoningContentBlock
  | BedrockCachePointBlock;

export type BedrockTextBlock = {
  text: string;
  cachePoint?: {
    type: "default";
  };
};

export type BedrockImageBlock = {
  image: {
    format: "png" | "jpeg" | "gif" | "webp";
    source: {
      bytes?: string; // base64 encoded
    };
  };
};

export type BedrockToolUseBlock = {
  toolUse: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  };
};

export type BedrockToolResultBlock = {
  toolResult: {
    toolUseId: string;
    content: BedrockToolResultContent[];
    status?: "success" | "error";
  };
};

export type BedrockToolResultContent =
  | { text: string }
  | { image: BedrockImageBlock["image"] };

// Message history type - used when sending back to API
// Claude Haiku 4.5 and Nova use this format
// Note: reasoningText and redactedContent are mutually exclusive (union type)
export type BedrockReasoningContentBlock = {
  reasoningContent:
    | {
        reasoningText: {
          text: string;
          signature?: string;
        };
      }
    | {
        redactedContent: string; // Base64-encoded binary
      };
};

// Internal type for accumulating reasoning content during streaming
// Note: Streaming API uses flat structure (reasoningContent.text, reasoningContent.redactedContent)
// but message history uses nested structure (reasoningContent.reasoningText.text, reasoningContent.redactedContent)
export type BedrockReasoningContentAccumulator = {
  reasoningContent: {
    text?: string;
    signature?: string;
    redactedContent?: string; // Base64-encoded binary
  };
};

// Internal type for accumulating partial content during streaming
// Note: reasoningContent uses flat structure during streaming, but nested structure in message history
export type BedrockAssistantContentBlockWithPartial = {
  text?: string;
  toolUse?: {
    toolUseId?: string;
    name?: string;
    input?: unknown;
  };
  reasoningContent?: {
    text?: string;
    signature?: string;
    redactedContent?: string; // Base64-encoded binary
  };
  cachePoint?: {
    type: "default";
  };
  _partialInput?: string;
};

export type BedrockCachePointBlock = {
  cachePoint: {
    type: "default";
  };
};

/* Tool Configuration */
export type BedrockToolConfig = {
  tools: BedrockTool[];
  toolChoice?: BedrockToolChoice;
};

export type BedrockTool = {
  toolSpec: {
    name: string;
    description?: string;
    inputSchema: {
      json: Record<string, unknown>;
    };
  };
};

export type BedrockToolChoice =
  | { auto: Record<string, never> }
  | { any: Record<string, never> }
  | { tool: { name: string } };

/* Response */
export type BedrockConverseResponse = {
  metrics: {
    latencyMs: number;
  };
  output: {
    message: BedrockAssistantMessage;
  };
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: BedrockUsage;
};

/* Usage */
export type BedrockUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
};

/* Stream Event */
export type BedrockStreamEvent =
  | BedrockStreamMessageStartEvent
  | BedrockStreamContentBlockStartEvent
  | BedrockStreamContentBlockDeltaEvent
  | BedrockStreamContentBlockStopEvent
  | BedrockStreamMessageStopEvent
  | BedrockStreamMetadataEvent;

export type BedrockStreamMessageStartEvent = {
  messageStart: {
    requestId: string;
  };
};

export type BedrockStreamContentBlockStartEvent = {
  contentBlockIndex: number;
  start: {
    text?: string;
    toolUse?: {
      toolUseId: string;
      name: string;
    };
  };
};

export type BedrockStreamContentBlockDeltaEvent = {
  contentBlockIndex: number;
  delta: {
    text?: string;
    toolUse?: {
      toolUseId?: string;
      name?: string;
      input?: string; // partial JSON
    };
    reasoningContent?: {
      text?: string;
      signature?: string;
      redactedContent?: string; // Base64-encoded binary
    };
  };
};

export type BedrockStreamContentBlockStopEvent = {
  contentBlockStop: {
    contentBlockIndex: number;
  };
};

export type BedrockStreamMessageStopEvent = {
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  additionalModelResponseFields?: Record<string, unknown>;
};

export type BedrockStreamMetadataEvent = {
  usage: BedrockUsage;
  metrics: {
    latencyMs: number;
  };
};
