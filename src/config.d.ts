import { ClaudeCodePluginRepo } from "./claudeCodePlugin.mjs";
import { ModelDefinition, PlatformConfig } from "./model.definition";
import { ToolUsePattern } from "./tool";
import { ExecCommandSanboxConfig } from "./tools/execCommand";
import {
  WebFetchToolGeminiOptions,
  WebFetchToolGeminiVertexAIOptions,
} from "./tools/webFetch.mjs";
import {
  WebSearchToolGeminiOptions,
  WebSearchToolGeminiVertexAIOptions,
} from "./tools/webSearch.mjs";

/**
 * JSON-serializable webFetch configuration.
 *
 * The `command` provider runs an arbitrary local command per fetch to
 * download a URL's content; the agent's main model is then used to answer
 * based on the dumped output. The runtime tool factory receives a resolved
 * `modelCaller` instead — see `WebFetchToolOptions` in `tools/webFetch.mjs`.
 */
export type WebFetchToolConfig =
  | WebFetchToolGeminiOptions
  | WebFetchToolGeminiVertexAIOptions
  | WebFetchToolCommandJsonConfig;

export type WebFetchToolCommandJsonConfig = {
  provider: "command";
  /** Executable used to fetch the URL (e.g., `"w3m"`, `"curl"`). */
  command: string;
  /** Arguments passed before the URL (e.g., `["-dump"]`). The URL is appended automatically. */
  args: string[];
  /** Per-call timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Extra environment variables, merged on top of PATH / HOME / LANG. */
  env?: Record<string, string>;
  maxLength?: number;
};

/**
 * JSON-serializable webSearch configuration.
 *
 * The `command` provider runs an arbitrary local command per keyword set
 * to perform a search; the agent's main model is then used to filter the
 * combined results down to entries relevant to the question. The runtime
 * tool factory receives a resolved `modelCaller` instead — see
 * `WebSearchToolOptions` in `tools/webSearch.mjs`.
 */
export type WebSearchToolConfig =
  | WebSearchToolGeminiOptions
  | WebSearchToolGeminiVertexAIOptions
  | WebSearchToolCommandJsonConfig;

export type WebSearchToolCommandJsonConfig = {
  provider: "command";
  /** Executable used to perform each search (e.g., a wrapper around a search API). */
  command: string;
  /** Arguments passed before each keyword set (e.g., `["-n", "5"]`). Keywords are appended automatically. */
  args: string[];
  /** Per-search timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Extra environment variables, merged on top of PATH / HOME / LANG. */
  env?: Record<string, string>;
  maxLengthPerSearch?: number;
  maxTotalLength?: number;
};

export type AppConfig = {
  model?: string;
  models?: ModelDefinition[];
  platforms?: PlatformConfig[];
  autoApproval?: {
    patterns?: ToolUsePattern[];
    tests?: AutoApprovalTestCase[];
    maxApprovals?: number;
    defaultAction?: "deny" | "ask";
    /** Additional absolute paths to allow for auto-approval (outside working directory) */
    allowedPaths?: string[];
    /** Allow access to git-unmanaged files (default: false) */
    allowGitUnmanagedFiles?: boolean;
  };
  sandbox?: ExecCommandSanboxConfig;
  tools?: {
    webSearch?: WebSearchToolConfig;
    webFetch?: WebFetchToolConfig;
    tmux?: { enabled: boolean };
  };
  mcpServers?: Record<string, MCPServerConfig>;
  notifyCmd?: { command: string; args?: string[] };
  autoCompact?: {
    softLimit?: number;
    softLimitPerModelPrefix?: Record<string, number>;
  };
  claudeCodePlugins?: ClaudeCodePluginRepo[];
};

export type AutoApprovalTestCase = {
  desc: string;
  toolUse: { toolName: string; input?: Record<string, unknown> };
  expectedAction: "allow" | "deny" | "ask" | null;
};

export type MCPServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  options?: {
    enabledTools?: string[];
  };
};
