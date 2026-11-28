/**
 * @import { SandboxConfig } from "./config"
 * @import { ExecCommandInput } from "./tools/execCommand"
 */

/**
 * Build an invocation of the configured sandbox. The caller decides whether
 * command-specific rules apply before choosing this execution path.
 *
 * @param {SandboxConfig} sandbox
 * @param {ExecCommandInput} input
 * @param {string[]} [additionalArgs]
 * @returns {{command: string, args: string[]}}
 */
export function sandboxCommand(sandbox, input, additionalArgs = []) {
  return {
    command: sandbox.command,
    args: [
      ...(sandbox.args ?? []),
      ...additionalArgs,
      ...(sandbox.separator ? [sandbox.separator] : []),
      input.command,
      ...(input.args ?? []),
    ],
  };
}
