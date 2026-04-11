/**
 * @typedef {HelpSubcommand | InteractiveSubcommand | BatchSubcommand | ListModelsSubcommand | InstallClaudeCodePluginsSubcommand} Subcommand
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
  list-models                  List available models
  install-claude-code-plugins  Install Claude Code plugins

Examples:
  plain -m gpt-5.4+thinking-medium
  plain batch \\
        -c ~/.config/plain-agent/config.local.json \\
        -c .plain-agent/config.json \\
        "Add tests for ..."
`);
  process.exit(exitCode);
}
