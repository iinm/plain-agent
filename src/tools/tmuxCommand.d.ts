import type { ToolEnvConfig } from "../tool";
import type { ExecCommandSanboxConfig } from "./execCommand";

export type TmuxCommandInput = {
  command: string;
  args?: string[];
};

export type TmuxCommandConfig = ToolEnvConfig & {
  sandbox?: ExecCommandSanboxConfig;
};
