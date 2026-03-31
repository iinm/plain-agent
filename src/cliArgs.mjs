/**
 * @typedef {Object} CliArgs
 * @property {string|null} model - Model name with variant
 * @property {boolean} showHelp - Whether to show help message
 * @property {boolean} listModels - Whether to list available models
 * @property {string|null} batch - Task instruction for batch mode
 * @property {string[]} config - Paths to additional config files for batch mode
 */

/**
 * Parse command-line arguments.
 * @param {string[]} argv - process.argv or similar
 * @returns {CliArgs}
 */
export function parseCliArgs(argv) {
  const args = argv.slice(2);
  /** @type {CliArgs} */
  const result = {
    model: null,
    showHelp: false,
    listModels: false,
    batch: null,
    config: [],
  };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-m" || args[i] === "--model") && args[i + 1]) {
      result.model = args[++i];
    } else if (args[i] === "-h" || args[i] === "--help") {
      result.showHelp = true;
    } else if (args[i] === "-l" || args[i] === "--list-models") {
      result.listModels = true;
    } else if (args[i] === "--batch" && args[i + 1]) {
      result.batch = args[++i];
    } else if (args[i] === "--config" && args[i + 1]) {
      result.config.push(args[++i]);
    }
  }

  return result;
}

/**
 * Print help message and exit.
 * @param {number} [exitCode] - Exit code (default: 0)
 */
export function printHelp(exitCode = 0) {
  console.log(`
Usage: agent [options]
       agent --batch "task instruction" [options]

Options:
  -m, --model <model+variant>  Model to use
  -l, --list-models            List available models
  -h, --help          Show this help message
  --batch <task>      Run in batch mode with the given task instruction
  --config <file>     Config file to load (required in batch mode)
                      In batch mode, only explicitly specified config files are loaded

Examples:
  agent -m gpt-5.4+thinking-medium
  plain --batch "Add tests for src/main.mjs" \\
        --config ~/.config/plain-agent/config.local.json \\
        --config .plain-agent/config.json
`);
  process.exit(exitCode);
}
