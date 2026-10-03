import type { ExecCommandSanboxConfig } from "./execCommand";

export type TmuxCommandInput = {
  command: string;
  args?: string[];
};

export type TmuxCommandConfig = {
  sandbox?: ExecCommandSanboxConfig;
};
