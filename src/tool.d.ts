import type { MessageContentToolUse } from "./model";

export type Tool = {
  def: ToolDefinition;
  impl: ToolImplementation;
  validateInput?: (input: Record<string, unknown>) => Error | undefined;
  maskApprovalInput?: (
    input: Record<string, unknown>,
  ) => Record<string, unknown>;
  /**
   * Mask secrets in tool output and error messages.
   * Called by `toolExecutor` alongside every other tool's `maskSecrets`; mask
   * only the secrets this tool owns and return any other text unchanged.
   */
  maskSecrets?: (text: string) => string;
  injectImpl?: (impl: ToolImplementation) => void;
};

export type SandboxMode =
  | {
      mode: "sandbox";
      additionalArgs?: string[];
    }
  | {
      mode: "unsandboxed";
    }
  | undefined;

export type SandboxModeProvider = {
  getSandboxMode: (input: unknown) => SandboxMode;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolImplementation = (
  input: Record,
) => Promise<string | StructuredToolResultContent[] | Error>;

export type StructuredToolResultContent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      // base64 encoded
      data: string;
      // e.g., image/jpeg
      mimeType: string;
    };

export type ToolUseApproverConfig = {
  patterns: ToolUsePattern[];
  maxApprovals: number;
  defaultAction: "deny" | "ask";
  /** Additional absolute paths to allow for auto-approval (outside working directory) */
  allowedPaths?: string[];
  /** Allow access to git-unmanaged files (default: false) */
  allowGitUnmanagedFiles?: boolean;

  /**
   * Mask the input before auto-approval checks and recording.
   * Return a redacted object (e.g., keep only necessary fields) that will be used for:
   * - safety validation via findUnsafeToolInputReason
   * - storing per-session allowed tool-use patterns
   */
  maskApprovalInput: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Record<string, unknown>;

  shouldSkipPathValidation?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => boolean;
};

export type ToolUseDecision = {
  action: "allow" | "deny" | "ask";
  reason?: string;
};

export type ToolUseApprover = {
  isAllowedToolUse: (toolUse: MessageContentToolUse) => ToolUseDecision;
  allowToolUse: (toolUse: MessageContentToolUse) => void;
  resetApprovalCount: () => void;
};

export type ToolUsePattern = {
  toolName: ValuePattern;
  input?: ObjectPattern;
  action?: "allow" | "deny" | "ask";
  reason?: string;
};

export type ToolUse = {
  toolName: string;
  input: Record<string, unknown>;
};
