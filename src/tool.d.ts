import type { MessageContentToolUse } from "./model";

export type Tool = {
  def: ToolDefinition;
  impl: ToolImplementation;
  validateInput?: (input: Record<string, unknown>) => Error | undefined;
  maskApprovalInput?: (
    input: Record<string, unknown>,
  ) => Record<string, unknown>;
  injectImpl?: (impl: ToolImplementation) => void;
};

export type SandboxMode = "sandbox" | "unsandboxed" | null;

/**
 * Implemented by tools that can report the sandbox mode for a given input.
 * - `null` if the tool has no sandbox configuration
 * - `"unsandboxed"` if a sandbox rule matched with `mode: "unsandboxed"`
 * - `"sandbox"` otherwise (sandbox config exists, default execution is sandboxed)
 * Used by the CLI to display an `[unsandboxed]` badge for tool calls that
 * will execute outside the sandbox.
 */
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
   * Skip file path validation (`isSafeToolInput`) entirely (default: false).
   * ⚠️ Disables a security check. Use only in a sandboxed environment.
   */
  skipPathValidation?: boolean;

  /**
   * Mask the input before auto-approval checks and recording.
   * Return a redacted object (e.g., keep only necessary fields) that will be used for:
   * - safety validation via isSafeToolInput
   * - storing per-session allowed tool-use patterns
   */
  maskApprovalInput: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Record<string, unknown>;
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
