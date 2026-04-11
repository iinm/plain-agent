/**
 * @import { ClaudeCodePlugin } from "./claudeCodePlugin.mjs"
 */

import { styleText } from "node:util";
import { loadAgentRoles } from "./context/loadAgentRoles.mjs";
import { loadPrompts } from "./context/loadPrompts.mjs";

// Define available slash commands for tab completion
export const SLASH_COMMANDS = [
  { name: "/help", description: "Display this help message" },
  { name: "/agents", description: "List available agent roles" },
  {
    name: "/agents:<id>",
    description:
      "Delegate to an agent with the given ID (e.g., /agents:code-simplifier)",
  },
  { name: "/prompts", description: "List available prompts" },
  {
    name: "/prompts:<id>",
    description:
      "Invoke a prompt with the given ID (e.g., /prompts:feature-dev)",
  },
  {
    name: "/<id>",
    description:
      "Shortcut for prompts in the shortcuts/ directory (e.g., /commit)",
  },
  { name: "/paste", description: "Paste content from clipboard" },
  {
    name: "/resume",
    description: "Resume conversation after an LLM provider error",
  },
  { name: "/dump", description: "Save current messages to a JSON file" },
  { name: "/load", description: "Load messages from a JSON file" },
  { name: "/cost", description: "Display session cost and token usage" },
];

/**
 * @typedef {Object} CompletionCandidate
 * @property {string} name
 * @property {string} description
 */

/**
 * Find candidates that match the line, prioritizing prefix matches.
 * @param {(string | CompletionCandidate)[]} candidates
 * @param {string} line
 * @param {number} queryStartIndex
 * @returns {(string | CompletionCandidate)[]}
 */
function findMatches(candidates, line, queryStartIndex) {
  const query = line.slice(queryStartIndex);
  const prefixMatches = [];
  const partialMatches = [];

  for (const candidate of candidates) {
    const name = typeof candidate === "string" ? candidate : candidate.name;
    if (name.startsWith(line)) {
      prefixMatches.push(candidate);
    } else if (
      query.length > 0 &&
      name.slice(queryStartIndex).includes(query)
    ) {
      partialMatches.push(candidate);
    }
  }

  return [...prefixMatches, ...partialMatches];
}

/**
 * Return the longest common prefix of the given strings.
 * @param {string[]} strings
 * @returns {string}
 */
function commonPrefix(strings) {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

/**
 * Display completion candidates and invoke the readline callback.
 *
 * Node.js readline normally requires two consecutive Tab presses to show the
 * candidate list. This helper lets readline handle the common-prefix
 * auto-completion first, then prints the candidate list on the next tick and
 * redraws the prompt so the display stays clean.
 *
 * @param {import("node:readline").Interface} rl
 * @param {(string | CompletionCandidate)[]} candidates
 * @param {string} line
 * @param {(err: Error | null, result: [string[], string]) => void} callback
 */
function showCompletions(rl, candidates, line, callback) {
  const names = candidates.map((c) => (typeof c === "string" ? c : c.name));
  if (candidates.length <= 1) {
    callback(null, [names, line]);
    return;
  }
  const prefix = commonPrefix(names);
  if (prefix.length > line.length) {
    // Let readline insert the common prefix.
    callback(null, [[prefix], line]);
  } else {
    // Nothing new to insert.
    callback(null, [[], line]);
  }
  // After readline finishes its own refresh, print the candidate list and
  // redraw the prompt line.  We cannot use rl.prompt(true) because its
  // internal _refreshLine clears everything below the prompt start, which
  // erases the candidate list we just wrote.  Instead we manually re-output
  // the prompt and current line content.
  setTimeout(() => {
    const maxLength = process.stdout.columns ?? 100;
    const list = candidates
      .map((c) => {
        if (typeof c === "string") return c;
        const nameText = c.name.padEnd(25);
        const separator = " - ";
        const descText = c.description;

        // 画面幅に合わせて説明文をカット（色を付ける前に計算）
        const availableWidth =
          maxLength - nameText.length - separator.length - 3;
        const displayDesc =
          descText.length > availableWidth && availableWidth > 0
            ? `${descText.slice(0, availableWidth)}...`
            : descText;

        const name = styleText("cyan", nameText);
        const description = styleText("dim", displayDesc);
        return `${name}${separator}${description}`;
      })
      .join("\r\n");
    process.stdout.write(`\r\n${list}\r\n`);
    process.stdout.write(`${rl.getPrompt()}${rl.line}`);
  }, 0);
}

/**
 * Create a completer function for readline.
 *
 * Because the readline.Interface instance (`cli`) is not available until after
 * `readline.createInterface` returns, we accept a getter function so the
 * completer can resolve the reference lazily at call time.
 *
 * @param {() => import("node:readline").Interface} getCliRef - A function that returns the readline Interface
 * @param {ClaudeCodePlugin[] | undefined} claudeCodePlugins
 * @returns {(line: string, callback: (err?: Error | null, result?: [string[], string]) => void) => void}
 */
export function createCompleter(getCliRef, claudeCodePlugins) {
  return (line, callback) => {
    (async () => {
      try {
        const cli = getCliRef();
        const prompts = await loadPrompts(claudeCodePlugins);
        const agentRoles = await loadAgentRoles(claudeCodePlugins);

        if (line.startsWith("/agents:")) {
          const prefix = "/agents:";
          const candidates = Array.from(agentRoles.values()).map((a) => ({
            name: `${prefix}${a.id}`,
            description: a.description,
          }));
          const hits = findMatches(candidates, line, prefix.length);

          showCompletions(cli, hits, line, callback);
          return;
        }

        if (line.startsWith("/prompts:")) {
          const prefix = "/prompts:";
          const candidates = Array.from(prompts.values()).map((p) => ({
            name: `${prefix}${p.id}`,
            description: p.description,
          }));
          const hits = findMatches(candidates, line, prefix.length);

          showCompletions(cli, hits, line, callback);
          return;
        }

        if (line.startsWith("/")) {
          const shortcuts = Array.from(prompts.values())
            .filter((p) => p.isShortcut)
            .map((p) => ({
              name: `/${p.id}`,
              description: p.description,
            }));

          const allCommands = [...SLASH_COMMANDS, ...shortcuts].filter(
            (cmd) => {
              const name = typeof cmd === "string" ? cmd : cmd.name;
              return (
                name !== "/<id>" &&
                (name === "/agents:" || !name.startsWith("/agents:")) &&
                (name === "/prompts:" || !name.startsWith("/prompts:"))
              );
            },
          );

          const hits = findMatches(allCommands, line, 1);

          showCompletions(cli, hits, line, callback);
          return;
        }

        callback(null, [[], line]);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        callback(error, [[], line]);
      }
    })();
  };
}
