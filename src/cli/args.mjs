/**
 * @typedef {HelpSubcommand | InteractiveSubcommand | BatchSubcommand | ListModelsSubcommand | InstallClaudeCodePluginsSubcommand | CostSubcommand | ResumeSubcommand | TestApprovalSubcommand | SandboxSubcommand} Subcommand
 */

/**
 * @typedef {{ type: 'help' }} HelpSubcommand
 */

/**
 * @typedef {{ type: 'interactive', config: string[], model: string | null }} InteractiveSubcommand
 */

/**
 * @typedef {{ type: 'batch', task: string, config: string[], model: string | null }} BatchSubcommand
 */

/**
 * @typedef {{ type: 'list-models' }} ListModelsSubcommand
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
 * Resume a previously interrupted interactive session.
 * - `sessionId === null` and `list === false`: resume the most recently updated session.
 * - `list === true`: print the resumable sessions and exit.
 * @typedef {{ type: 'resume', sessionId: string | null, list: boolean, config: string[] }} ResumeSubcommand
 */

/**
 * Launch plain-sandbox interactively using the app config's sandbox settings.
 * Arguments after `--` are passed through to plain-sandbox as-is.
 * @typedef {{ type: 'sandbox', config: string[], passthroughArgs: string[] }} SandboxSubcommand
 */

/**
 * @typedef {Object} CliArgs
 * @property {Subcommand} subcommand - The subcommand to execute
 */

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
    const config = [];
    let model = null;

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
      }
    }

    return {
      subcommand: { type: "interactive", config, model },
    };
  }

  if (subcommandName === "batch") {
    const batchArgs = args.slice(1);

    let task = null;
    let model = null;
    const config = [];

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
      } else if (!batchArgs[i].startsWith("-") && !task) {
        task = batchArgs[i];
      }
    }

    return {
      subcommand: { type: "batch", task: task || "", config, model },
    };
  }

  if (subcommandName === "list-models") {
    return {
      subcommand: { type: "list-models" },
    };
  }

  if (subcommandName === "install-claude-code-plugins") {
    return {
      subcommand: { type: "install-claude-code-plugins" },
    };
  }

  if (subcommandName === "resume") {
    const resumeArgs = args.slice(1);
    /** @type {string | null} */
    let sessionId = null;
    let list = false;
    /** @type {string[]} */
    const config = [];

    for (let i = 0; i < resumeArgs.length; i++) {
      const arg = resumeArgs[i];
      if (arg === "--list") {
        list = true;
      } else if (arg === "-c" || arg === "--config") {
        if (resumeArgs[i + 1]) {
          config.push(resumeArgs[i + 1]);
          i++;
        }
      } else if (arg === "-m" || arg === "--model") {
        // Switching models on resume is not supported by design.
        return {
          subcommand: { type: "help" },
        };
      } else if (!arg.startsWith("-") && sessionId === null) {
        sessionId = arg;
      }
    }

    return {
      subcommand: { type: "resume", sessionId, list, config },
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

/**
 * Print help message and exit.
 * @param {number} [exitCode] - Exit code (default: 0)
 */
export function printHelp(exitCode = 0) {
  console.log(`
Usage: plain [options]
       plain batch [options] <task>
       plain resume [<sessionId>] [--list]
       plain sandbox [-c <file>...] -- <plain-sandbox args>
       plain cost [--from YYYY-MM-DD] [--to YYYY-MM-DD]
       plain list-models
       plain install-claude-code-plugins

Options:
  -m, --model <model+variant>  Model to use
  -h, --help                   Show this help message
  -c, --config <file>          Config file to load (repeatable)

Subcommands:
  batch <task>                 Run in batch mode with the given task instruction.
                               Config files are NOT auto-loaded in batch mode;
                               use -c to specify config files explicitly.
  resume                       Resume an interactive session that was
                               interrupted. With no sessionId, resumes the
                               most recently updated session. Use --list to
                               see resumable sessions. Switching models is
                               not supported (-m is rejected).
  test-approval                Run auto-approval rule tests defined in config.
  sandbox                      Launch plain-sandbox interactively using the app
                               config's sandbox settings. Arguments after -- are
                               passed through to plain-sandbox as-is.
  cost                         Show aggregated token cost per day for a period.
                               Defaults to the first day of the current month
                               through today.
  list-models                  List available models
  install-claude-code-plugins  Install Claude Code plugins

Examples:
  plain -m claude-sonnet-4-6+thinking-high
  plain batch \\
        -c ~/.config/plain-agent/config.local.json \\
        -c .plain-agent/config.json \\
        "Add tests for ..."
`);
  process.exit(exitCode);
}
