export type ExecCommandInput = {
  command: string;
  args?: string[];
};

export type ExecCommandConfig = {
  env?: Record<string, string>;
  secrets?: Record<string, string>;
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
