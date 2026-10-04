/**
 * @import { Tool, SandboxMode, SandboxModeProvider } from '../tool'
 * @import { TmuxCommandConfig, TmuxCommandInput } from './tmuxCommand'
 */

import { execFile } from "node:child_process";
import { createSecretMasker } from "../utils/maskSecrets.mjs";
import { noThrow } from "../utils/noThrow.mjs";

const OUTPUT_MAX_LENGTH = 1024 * 8;

/**
 * Sandbox-aware tmux command tool
 * @param {TmuxCommandConfig=} config
 * @returns {Tool & SandboxModeProvider}
 */
export function createTmuxCommandTool(config) {
  const maskSecrets = createSecretMasker(config?.secrets ?? {});
  /** @param {string} text */
  const mask = (text) => maskSecrets?.(text) ?? text;
  const sessionEnv = { ...(config?.env ?? {}), ...(config?.secrets ?? {}) };
  const envArgs = Object.entries(sessionEnv).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);

  /** @type {Tool & SandboxModeProvider} */
  return {
    def: {
      name: "tmux_command",
      description: [
        "Run a tmux command. Use this for long-running foreground processes (e.g., web servers, REPL). Execute commands directly otherwise.",
        "The tmux session id is plain-agent-<session-id>.",
        "",
        "Examples:",
        '- Start session: new-session ["-d", "-s", "<tmux-session-id>"]',
        '- Detect window number to send keys: list-windows ["-t", "<tmux-session-id>"]',
        '- Get output of window before sending keys: capture-pane ["-p", "-t", "<tmux-session-id>:<window>"]',
        '- Send key to session: send-keys ["-t", "<tmux-session-id>:<window>", "echo hello", "Enter"]',
        '- Delete line: send-keys ["-t", "<tmux-session-id>:<window>", "C-a", "C-k"]',
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            description: "The tmux command to run",
            type: "string",
          },
          args: {
            description: "Arguments to pass to the tmux command",
            type: "array",
            items: {
              type: "string",
            },
          },
        },
        required: ["command"],
      },
    },

    /**
     * @param {TmuxCommandInput} input
     * @returns {Promise<string | Error>}
     */
    impl: async (input) =>
      await noThrow(async () => {
        const { command } = input;
        const args = input.args || [];
        const normalizedCommand = normalizeTmuxCommand(command);

        // tmux treats ";" as a command separator, so escape it before sending
        if (command === "send-keys") {
          for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (arg.endsWith(";") && !arg.endsWith("\\;")) {
              args[i] = `${arg.slice(0, -1)}\\;`;
            }
          }
        }

        const execFileOptions = {
          shell: false,
          env: {
            PWD: process.env.PWD,
            PATH: process.env.PATH,
            HOME: process.env.HOME,
          },
        };

        /**
         * @param {{command: string, args: string[]}} input
         * @returns {{command: string, args: string[]}}
         */
        const useSandbox = ({ command, args }) => {
          if (config?.sandbox) {
            return {
              command: config.sandbox.command,
              args: [...(config.sandbox.args || []), command, ...args],
            };
          }
          return { command, args };
        };

        const isSessionCreation = normalizedCommand === "new-session";
        const execFileTmuxCommandInput = useSandbox({
          command: "tmux",
          args: [command, ...(isSessionCreation ? envArgs : []), ...args],
        });

        return new Promise((resolve, _reject) => {
          execFile(
            execFileTmuxCommandInput.command,
            execFileTmuxCommandInput.args,
            execFileOptions,
            async (err, stdout, stderr) => {
              // capture-pane output may include blank lines, so trim it
              const stdoutTrimmed = mask(stdout.trim());
              const stdoutTruncated = stdoutTrimmed.slice(-OUTPUT_MAX_LENGTH);
              const isStdoutTruncated =
                stdoutTrimmed.length > OUTPUT_MAX_LENGTH;
              const stderrTrimmed = mask(stderr.trim());
              const stderrTruncated = stderrTrimmed.slice(-OUTPUT_MAX_LENGTH);
              const isStderrTruncated =
                stderrTrimmed.length > OUTPUT_MAX_LENGTH;
              const result = [
                stdoutTruncated
                  ? `<stdout>\n${isStdoutTruncated ? "(Output truncated) ..." : ""}${stdoutTruncated}\n</stdout>`
                  : "<stdout></stdout>",
                "",
                stderrTruncated
                  ? `<stderr>\n${isStderrTruncated ? "(Output truncated) ..." : ""}${stderrTruncated}\n</stderr>`
                  : "<stderr></stderr>",
              ];
              if (!stderr && err) {
                const errMessageMasked = mask(err.message);
                const errMessageTruncated = errMessageMasked.slice(
                  0,
                  OUTPUT_MAX_LENGTH,
                );
                const isErrMessageTruncated =
                  errMessageMasked.length > OUTPUT_MAX_LENGTH;
                result.push(
                  `\n<error>\n${err.name}: ${errMessageTruncated}${isErrMessageTruncated ? "... (Message truncated)" : ""}</error>`,
                );
              }

              if (
                normalizedCommand === "new-session" ||
                normalizedCommand === "new-window"
              ) {
                // show window list after creating a new session or window
                const targetPosition =
                  normalizedCommand === "new-window"
                    ? args.indexOf("-t") + 1
                    : args.indexOf("-s") + 1;
                const target = args[targetPosition];

                const execFileTmuxListWindowInput = useSandbox({
                  command: "tmux",
                  args: ["list-windows", "-t", target],
                });
                const listWindowResult = await new Promise(
                  (resolve, _reject) => {
                    execFile(
                      execFileTmuxListWindowInput.command,
                      execFileTmuxListWindowInput.args,
                      execFileOptions,
                      (err, stdout, _stderr) => {
                        if (err) {
                          console.error(
                            mask(
                              `Failed to list tmux windows: ${err.message}, stack=${err.stack}`,
                            ),
                          );
                        }
                        return resolve(stdout);
                      },
                    );
                  },
                );
                result.push(
                  `\n<tmux:list-windows>\n${mask(listWindowResult)}</tmux:list-windows>`,
                );
              }

              if (command === "send-keys") {
                const targetPosition = args.indexOf("-t") + 1;
                const target = args[targetPosition];

                /**
                 * @param {string} target
                 * @returns {Promise<string>}
                 */
                const capturePane = (target) =>
                  new Promise((resolve, _reject) => {
                    const execFileTmuxCapturePaneInput = useSandbox({
                      command: "tmux",
                      args: ["capture-pane", "-p", "-t", target],
                    });
                    execFile(
                      execFileTmuxCapturePaneInput.command,
                      execFileTmuxCapturePaneInput.args,
                      execFileOptions,
                      (err, stdout, _stderr) => {
                        if (err) {
                          console.error(
                            mask(
                              `Failed to capture tmux pane: ${err.message}, stack=${err.stack}`,
                            ),
                          );
                        }
                        return resolve(stdout.trim());
                      },
                    );
                  });

                // Wait until the output stabilizes
                const initial = await capturePane(target);
                let previous = initial;
                let captured = "";

                const waitIntervalMs = 500;
                const maxWaitTimeMs = 2000;

                for (let i = 0; i < maxWaitTimeMs / waitIntervalMs; i++) {
                  await new Promise((resolve) =>
                    setTimeout(resolve, waitIntervalMs),
                  );
                  captured = await capturePane(target);
                  if (captured !== initial && captured === previous) break;
                  previous = captured;
                }

                const capturedMasked = mask(captured);
                const capturedTruncated = capturedMasked.slice(
                  -OUTPUT_MAX_LENGTH,
                );
                const isCapturedTruncated =
                  capturedMasked.length > OUTPUT_MAX_LENGTH;
                result.push(
                  `\n<tmux:capture-pane target="${target}">\n${isCapturedTruncated ? "(Output truncated) ..." : ""}${capturedTruncated}\n</tmux:capture-pane>`,
                );
              }

              return resolve(result.join("\n"));
            },
          );
        });
      }),

    /**
     * @param {unknown} _input
     * @returns {SandboxMode}
     */
    getSandboxMode: (_input) => {
      if (!config?.sandbox) {
        return undefined;
      }
      return {
        mode: "sandbox",
      };
    },
    maskOutput: maskSecrets,
  };
}

/**
 * tmux accepts unambiguous command abbreviations (e.g. `new`, `new-s`), so
 * normalize them to the canonical name. Used for session detection so that
 * `-e` injection works regardless of abbreviation.
 * @param {string} command
 * @returns {string}
 */
function normalizeTmuxCommand(command) {
  if (command.length === 0) return command;
  return (
    ["new-session", "new-window"].find((c) => c.startsWith(command)) ?? command
  );
}
