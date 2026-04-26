import { ClaudeCodePluginRepo } from "./claudeCodePlugin.mjs";
import { ModelDefinition, PlatformConfig } from "./modelDefinition";
import { ToolUsePattern } from "./tool";
import { AskURLToolOptions } from "./tools/askURL.mjs";
import { AskWebToolOptions } from "./tools/askWeb.mjs";
import { ExecCommandSanboxConfig } from "./tools/execCommand";
import { VoiceInputConfig } from "./voiceInput.mjs";

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
    askURL?: AskURLToolOptions;
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
