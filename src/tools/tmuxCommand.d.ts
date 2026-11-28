import type { SandboxConfig } from "../config";

export type TmuxCommandInput = {
  command: string;
  args?: string[];
};

export type TmuxCommandConfig = {
  sandbox?: SandboxConfig;
};
