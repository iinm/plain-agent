import type { SandboxConfig } from "../config";

export type ExecCommandInput = {
  command: string;
  args?: string[];
};

export type ExecCommandConfig = {
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  sandbox?: SandboxConfig;
};
