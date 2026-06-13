/**
 * @import { Tool, SandboxModeProvider } from '../tool'
 * @import { ExecCommandConfig, ExecCommandInput, ExecCommandSanboxConfig } from './execCommand'
 */

import { execFile } from "node:child_process";
import { writeTmpFile } from "../tmpfile.mjs";
import { matchValue } from "../utils/matchValue.mjs";
import { noThrow } from "../utils/noThrow.mjs";

const OUTPUT_MAX_LENGTH = 1024 * 8;
const OUTPUT_TRUNCATED_LENGTH = 1024 * 2;

/**
 * @param {ExecCommandConfig=} config
 * @returns {Tool & SandboxModeProvider}
 */
export function createExecCommandTool(config) {
  /** @type {Tool & SandboxModeProvider} */
  return {
    def: {
      name: "exec_command",
      description: `Run a command without shell interpretation.

Examples:
- List directories or find files: fd [".", "./", "--max-depth", "3", "--type", "d", "--hidden"]
- Search for strings: rg ["--heading", "--line-number", "pattern", "./"]
- Manage GitHub issues and PRs:
  Get PR details: gh ["pr", "view", "123", "--json", "title,body,url"]
  Get PR comment: gh ["api", "--method", "GET", "repos/<owner>/<repo>/pulls/comments/<id>", "--jq", "{user: .user.login, path: .path, line: .line, body: .body}"]
      `.trim(),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            description: "The executable name or path. e.g., rg",
            type: "string",
          },
          args: {
            description: "Array of arguments to pass to the command.",
            type: "array",
            items: {
              type: "string",
            },
          },
        },
        required: ["command"],
      },
    },

    validateInput: (input) => {
      if (typeof input.command !== "string") {
        return new Error("command must be a string");
      }

      // Example: fd<arg_key>args</arg_key><arg_value>[... (GLM-5)
      if (input.command.match(/[<>]/)) {
        return new Error(
          `invalid tool use format: command=${JSON.stringify(input.command)}`,
        );
      }

      if (input.command.startsWith("-")) {
        return new Error("command must not start with '-'");
      }

      if (input.args && !Array.isArray(input.args)) {
        return new Error("args must be an array of strings");
      }

      return;
    },

    /**
     * @param {ExecCommandInput} input
     * @returns {Promise<string | Error>}
     */
    impl: async (input) =>
      await noThrow(async () => {
        const { command, args } = config?.sandbox
          ? rewriteInputForSandbox(input, config.sandbox)
          : input;
        return new Promise((resolve, _reject) => {
          const child = execFile(
            command,
            args,
            {
              shell: false,
              env: {
                PWD: process.env.PWD,
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                LANG: process.env.LANG,
              },
              timeout: 5 * 60 * 1000,
            },
            async (err, stdout, stderr) => {
              /**
               * @param {string} content
               * @param {string} type
               * @returns {Promise<string>}
               */
              const formatOutput = async (content, type) => {
                if (content.length <= OUTPUT_MAX_LENGTH) {
                  return content;
                }

                let fileExtension = "txt";
                try {
                  JSON.parse(content);
                  fileExtension = "json";
                } catch {
                  // not JSON
                }

                const prefix = `exec_command-${type}`;
                const filePath = await writeTmpFile(
                  content,
                  prefix,
                  fileExtension,
                );
                const lineCount = content.split("\n").length;

                const head = content.slice(0, OUTPUT_TRUNCATED_LENGTH);
                const tail = content.slice(
                  Math.max(content.length - OUTPUT_TRUNCATED_LENGTH, 0),
                );

                return [
                  `Content is too large (${content.length} characters, ${lineCount} lines). Saved to ${filePath}.`,
                  `<truncated_output part="start" length="${OUTPUT_TRUNCATED_LENGTH}" total_length="${content.length}">\n${head}\n</truncated_output>`,
                  `<truncated_output part="end" length="${OUTPUT_TRUNCATED_LENGTH}" total_length="${content.length}">\n${tail}</truncated_output>\n`,
                ].join("\n\n");
              };

              const stdoutOrMessage = await formatOutput(stdout, "stdout");
              const stderrOrMessage = await formatOutput(stderr, "stderr");

              const result = [
                stdoutOrMessage
                  ? `<stdout>\n${stdoutOrMessage}</stdout>`
                  : "<stdout></stdout>",
                "",
                stderrOrMessage
                  ? `<stderr>\n${stderrOrMessage}</stderr>`
                  : "<stderr></stderr>",
              ];

              if (!stderr && err) {
                // rg: exit status != 0 when no matches are found.
                const ignoreError = ["rg"].includes(input.command);
                if (!ignoreError) {
                  // mask sandbox details
                  const originalCommand = [
                    input.command,
                    ...(input.args ?? []),
                  ];
                  const sandboxedCommand = [command, ...(args ?? [])];
                  const sandboxStr = [
                    ...sandboxedCommand.slice(
                      0,
                      sandboxedCommand.length - originalCommand.length,
                    ),
                    "",
                  ].join(" ");

                  const errMessageMasked = sandboxStr
                    ? err.message.replaceAll(sandboxStr, "")
                    : err.message;

                  const errMessageTruncated = errMessageMasked.slice(
                    0,
                    OUTPUT_TRUNCATED_LENGTH,
                  );
                  const isErrMessageTruncated =
                    errMessageMasked.length > OUTPUT_TRUNCATED_LENGTH;

                  result.push(
                    [
                      "",
                      `<error code="${err.code}" killed="${err.killed}" signal="${err.signal}">`,
                      `${err.name}: ${errMessageTruncated}${isErrMessageTruncated ? "... (Message truncated)" : ""}</error>`,
                    ].join("\n"),
                  );
                }
              }
              return resolve(result.join("\n"));
            },
          );
          child.stdin?.end();
        });
      }),

    /**
     * Report the sandbox mode for a given tool input. Mirrors
     * `rewriteInputForSandbox`'s rule-matching logic so the CLI can preview
     * the mode before execution.
     * @param {unknown} input
     * @returns {"sandbox" | "unsandboxed" | null}
     */
    getSandboxMode: (input) => {
      if (!config?.sandbox) return null;
      const matchedRule = (config.sandbox.rules || []).find((rule) =>
        matchValue(/** @type {ExecCommandInput} */ (input), rule.pattern),
      );
      return matchedRule?.mode === "unsandboxed" ? "unsandboxed" : "sandbox";
    },
  };
}

/**
 * @param {ExecCommandInput} input
 * @param {ExecCommandSanboxConfig} sandbox
 * @returns {ExecCommandInput}
 */
function rewriteInputForSandbox(input, sandbox) {
  const matchedRule = (sandbox.rules || []).find((rule) =>
    matchValue(input, rule.pattern),
  );

  if (matchedRule?.mode === "unsandboxed") {
    return input;
  }

  const args = [
    ...(sandbox.args || []),
    ...(matchedRule?.additionalArgs || []),
  ];

  if (sandbox.separator) {
    args.push(sandbox.separator);
  }

  args.push(input.command);

  if (input.args) {
    args.push(...input.args);
  }

  return {
    command: sandbox.command,
    args,
  };
}
