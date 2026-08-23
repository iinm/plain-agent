/**
 * @typedef {HelpSubcommand | InteractiveSubcommand | BatchSubcommand | ListModelsSubcommand | ListSessionsSubcommand | InstallClaudeCodePluginsSubcommand | CostSubcommand | TestApprovalSubcommand | SandboxSubcommand} Subcommand
 */

/**
 * @typedef {{ type: 'help' }} HelpSubcommand
 */

/**
 * @typedef {{ type: 'interactive', config: string[], model: string | null, session: string | null }} InteractiveSubcommand
 */

/**
 * @typedef {{ type: 'batch', prompt: string, config: string[], model: string | null, session: string | null }} BatchSubcommand
 */

/**
 * @typedef {{ type: 'models' }} ListModelsSubcommand
 */

/**
 * @typedef {{ type: 'sessions' }} ListSessionsSubcommand
 */

/**
 * @typedef {{ type: 'install-claude-code-plugins' }} InstallClaudeCodePluginsSubcommand
 */

/**
 * @typedef {{ type: 'cost', from: string | null, to: string | null }} CostSubcommand
 */

/**
 * @typedef {{ type: 'test-approval', config: string[] }} TestApprovalSubcommand
 */

/**
 * Launch the sandbox command using the app config's sandbox settings.
 * Arguments after `--` are passed through to the sandbox command as-is.
 * @typedef {{ type: 'sandbox', config: string[], passthroughArgs: string[] }} SandboxSubcommand
 */

/**
 * @typedef {Object} CliArgs
 * @property {Subcommand} subcommand - The subcommand to execute
 */

export function printHelp() {
  console.log(`
Usage:

  plain [-h,--help]

  plain [-c,--config <additional-config-file>]
        [-m,--model <model+variant>]
        [-s,--session <resumable-session-id>]

Options:

  -h, --help    Display this help message and exit.

  -c, --config <additional-config-file>
                Load additional configuration (can be repeated).

  -m, --model <model+variant>
                Use specified model variant.

  -s, --session <resumable-session-id>
                Resume from previous session ID.
                Use "-" to resume from the most recently updated session.

Subcommands:

  models        List available models.

  sessions      List resumable sessions.

  batch [-c <config-file>] [-m <model+variant>] [-s <resumable-session-id>] PROMPT
                Run in batch mode with the given task instruction.
                Config files are NOT auto-loaded in batch mode;
                use -c to specify config files explicitly.

  cost [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                Show aggregated token cost per day for a period.
                Defaults to the first day of the current month through today.

  sandbox [-c <additional-config-file>] -- <sandbox args...>
                Launch the sandbox command using the app config's sandbox settings.
                Arguments after -- are passed through to the sandbox command as-is.

  test-approval [-c <additional-config-file>]
                Run auto-approval rule tests defined in config.

  install-claude-code-plugins
                Install Claude Code plugins.
`);
}

/**
 * Parse command-line arguments.
 * @param {string[]} argv - process.argv or similar
 * @returns {CliArgs}
 */
export function parseCliArgs(argv) {
  const args = argv.slice(2);
  const subcommandName = args[0];

  if (["-h", "--help", "help"].includes(subcommandName)) {
    return {
      subcommand: { type: "help" },
    };
  }

  if (!subcommandName || subcommandName.startsWith("-")) {
    // Interactive mode (default)
    /** @type {string[]} */
    const config = [];
    /** @type {string | null} */
    let model = null;
    /** @type {string | null} */
    let session = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-m" || args[i] === "--model") {
        if (args[i + 1]) {
          model = args[i + 1];
          i++;
        }
      } else if (args[i] === "-c" || args[i] === "--config") {
        if (args[i + 1]) {
          config.push(args[i + 1]);
          i++;
        }
      } else if (args[i] === "-s" || args[i] === "--session") {
        if (args[i + 1]) {
          session = args[i + 1];
          i++;
        }
      }
    }

    return {
      subcommand: { type: "interactive", config, model, session },
    };
  }

  if (subcommandName === "batch") {
    const batchArgs = args.slice(1);

    /** @type {string[]} */
    const config = [];
    /** @type {string | null} */
    let model = null;
    /** @type {string | null} */
    let session = null;
    /** @type {string | null} */
    let prompt = null;

    for (let i = 0; i < batchArgs.length; i++) {
      if (batchArgs[i] === "-m" || batchArgs[i] === "--model") {
        if (batchArgs[i + 1]) {
          model = batchArgs[i + 1];
          i++;
        }
      } else if (batchArgs[i] === "-c" || batchArgs[i] === "--config") {
        if (batchArgs[i + 1]) {
          config.push(batchArgs[i + 1]);
          i++;
        }
      } else if (batchArgs[i] === "-s" || batchArgs[i] === "--session") {
        if (batchArgs[i + 1]) {
          session = batchArgs[i + 1];
          i++;
        }
      } else if (!batchArgs[i].startsWith("-") && !prompt) {
        prompt = batchArgs[i];
      }
    }

    return {
      subcommand: {
        type: "batch",
        prompt: prompt || "",
        config,
        model,
        session,
      },
    };
  }

  if (subcommandName === "models") {
    return {
      subcommand: { type: "models" },
    };
  }

  if (subcommandName === "sessions") {
    return {
      subcommand: { type: "sessions" },
    };
  }

  if (subcommandName === "install-claude-code-plugins") {
    return {
      subcommand: { type: "install-claude-code-plugins" },
    };
  }

  if (subcommandName === "test-approval") {
    const subArgs = args.slice(1);
    /** @type {string[]} */
    const config = [];

    for (let i = 0; i < subArgs.length; i++) {
      if (subArgs[i] === "-c" || subArgs[i] === "--config") {
        if (subArgs[i + 1]) {
          config.push(subArgs[i + 1]);
          i++;
        }
      }
    }

    return {
      subcommand: { type: "test-approval", config },
    };
  }

  if (subcommandName === "sandbox") {
    const sandboxArgs = args.slice(1);
    /** @type {string[]} */
    const config = [];
    /** @type {string[]} */
    const passthroughArgs = [];

    for (let i = 0; i < sandboxArgs.length; i++) {
      if (sandboxArgs[i] === "--") {
        passthroughArgs.push(...sandboxArgs.slice(i + 1));
        break;
      }
      if (sandboxArgs[i] === "-c" || sandboxArgs[i] === "--config") {
        if (sandboxArgs[i + 1]) {
          config.push(sandboxArgs[i + 1]);
          i++;
        }
      }
    }

    return {
      subcommand: { type: "sandbox", config, passthroughArgs },
    };
  }

  if (subcommandName === "cost") {
    const costArgs = args.slice(1);
    let from = null;
    let to = null;
    for (let i = 0; i < costArgs.length; i++) {
      if (costArgs[i] === "--from") {
        if (costArgs[i + 1]) {
          from = costArgs[i + 1];
          i++;
        }
      } else if (costArgs[i] === "--to") {
        if (costArgs[i + 1]) {
          to = costArgs[i + 1];
          i++;
        }
      }
    }
    return {
      subcommand: { type: "cost", from, to },
    };
  }

  return {
    subcommand: { type: "help" },
  };
}
