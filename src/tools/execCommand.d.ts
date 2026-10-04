import type { ToolEnvConfig } from "../tool";

export type ExecCommandInput = {
  command: string;
  args?: string[];
};

export type ExecCommandConfig = ToolEnvConfig & {
  sandbox?: ExecCommandSanboxConfig;
};

export type ExecCommandSanboxConfig = {
  command: string;
  args?: string[];
  separator?: string;
  rules?: {
    pattern: {
      command: string;
      args?: string[];
    };
    mode: "sandbox" | "unsandboxed";
    additionalArgs?: string[];
  }[];
};
