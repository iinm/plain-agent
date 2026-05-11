import { ClaudeCodePluginRepo } from "./claudeCodePlugin.mjs";
import { ModelDefinition, PlatformConfig } from "./modelDefinition";
import { ToolUsePattern } from "./tool";
import {
  AskURLToolGeminiOptions,
  AskURLToolGeminiVertexAIOptions,
} from "./tools/askURL.mjs";
import { AskWebToolOptions } from "./tools/askWeb.mjs";
import { ExecCommandSanboxConfig } from "./tools/execCommand";
import { VoiceInputConfig } from "./voiceInput.mjs";

/**
 * JSON-serializable askURL configuration.
 *
 * The `command` provider runs an arbitrary local command per URL to fetch
 * its content; the agent's main model is then used to answer based on the
 * dumped output. The runtime tool factory receives a resolved `modelCaller`
 * instead — see `AskURLToolOptions` in `tools/askURL.mjs`.
 */
export type AskURLToolConfig =
  | AskURLToolGeminiOptions
  | AskURLToolGeminiVertexAIOptions
  | AskURLToolCommandJsonConfig;

export type AskURLToolCommandJsonConfig = {
  provider: "command";
  /** Executable used to fetch each URL (e.g., `"w3m"`, `"curl"`). */
  command: string;
  /** Arguments passed before the URL (e.g., `["-dump"]`). The URL is appended automatically. */
  args: string[];
  /** Per-URL timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Extra environment variables, merged on top of PATH / HOME / LANG. */
  env?: Record<string, string>;
  maxLengthPerURL?: number;
  maxTotalLength?: number;
};

export type AppConfig = {
  model?: string;
  models?: ModelDefinition[];
  platforms?: PlatformConfig[];
  autoApproval?: {
    patterns?: ToolUsePattern[];
    maxApprovals?: number;
    defaultAction?: "deny" | "ask";
  };
  sandbox?: ExecCommandSanboxConfig;
  tools?: {
    askWeb?: AskWebToolOptions;
    askURL?: AskURLToolConfig;
  };
  mcpServers?: Record<string, MCPServerConfig>;
  notifyCmd?: { command: string; args?: string[] };
  voiceInput?: VoiceInputConfig;
  claudeCodePlugins?: ClaudeCodePluginRepo[];
};

export type MCPServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  options?: {
    enabledTools?: string[];
  };
};
