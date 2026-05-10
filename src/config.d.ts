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
 * For `builtin+w3m`, the user specifies a `model` string (`"name+variant"`)
 * that is resolved against `models` at startup. The runtime tool factory
 * receives a resolved `modelCaller` instead — see `AskURLToolOptions` in
 * `tools/askURL.mjs`.
 */
export type AskURLToolConfig =
  | AskURLToolGeminiOptions
  | AskURLToolGeminiVertexAIOptions
  | AskURLToolBuiltinW3MJsonConfig;

export type AskURLToolBuiltinW3MJsonConfig = {
  provider: "builtin+w3m";
  /** "name+variant" referencing an entry in `models`. Defaults to the agent's main model. */
  model?: string;
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
