/**
 * @import { ClaudeCodePlugin } from "../claudeCodePlugin.mjs"
 * @import { TabContext } from "./lineEditor.mjs"
 */

import { styleText } from "node:util";
import { loadAgentRoles } from "../context/loadAgentRoles.mjs";
import { loadPrompts } from "../context/loadPrompts.mjs";
import { toOneLine } from "../utils/toOneLine.mjs";

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
  { name: "/cost", description: "Display session cost and token usage" },
  {
    name: "/compact",
    description:
      "Ask the agent to compact the context by reloading from a memory file",
  },
];

/**
 * @typedef {Object} CompletionCandidate
 * @property {string} name
 * @property {string} description
 */

/**
 * Create a completer that receives editor state via {@link TabContext}.
 *
 * @param {ClaudeCodePlugin[] | undefined} claudeCodePlugins
 * @returns {(ctx: TabContext) => void}
 */
export function createCompleter(claudeCodePlugins) {
  return (ctx) => {
    (async () => {
      try {
        const prompts = await loadPrompts(claudeCodePlugins);
        const agentRoles = await loadAgentRoles(claudeCodePlugins);

        if (ctx.line.startsWith("/agents:")) {
          const prefix = "/agents:";
          const candidates = Array.from(agentRoles.values()).map((a) => ({
            name: `${prefix}${a.id}`,
            description: a.description,
          }));
          const hits = findMatches(candidates, ctx.line, prefix.length);

          showCompletions(ctx, hits);
          return;
        }

        if (ctx.line.startsWith("/prompts:")) {
          const prefix = "/prompts:";
          const candidates = Array.from(prompts.values()).map((p) => ({
            name: `${prefix}${p.id}`,
            description: p.description,
          }));
          const hits = findMatches(candidates, ctx.line, prefix.length);

          showCompletions(ctx, hits);
          return;
        }

        if (ctx.line.startsWith("/")) {
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

          const hits = findMatches(allCommands, ctx.line, 1);

          showCompletions(ctx, hits);
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(styleText("red", `\nCompletion error: ${message}`));
        ctx.render();
      }
    })();
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
 * Display completion candidates and update the editor line.
 *
 * For a single match the line is replaced immediately.  For multiple matches
 * the longest common prefix is inserted (if longer than the current line) and
 * the full candidate list is printed below.
 *
 * @param {TabContext} ctx
 * @param {(string | CompletionCandidate)[]} candidates
 */
function showCompletions(ctx, candidates) {
  const names = candidates.map((c) => (typeof c === "string" ? c : c.name));

  if (candidates.length === 0) return;

  if (candidates.length === 1) {
    ctx.updateLine(names[0]);
    ctx.render();
    return;
  }

  const prefix = commonPrefix(names);
  if (prefix.length > ctx.line.length) {
    ctx.updateLine(prefix);
    ctx.render();
  }

  setTimeout(() => {
    const maxLength = process.stdout.columns ?? 100;
    const list = candidates
      .map((c) => {
        if (typeof c === "string") return c;
        const nameText = c.name.padEnd(25);
        const separator = " - ";
        const descText = toOneLine(c.description);

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
    ctx.render();
  }, 0);
}
