/**
 * @import { Message, MessageContentToolUse, MessageContentToolResult, ProviderTokenUsage } from "./model"
 * @import { CompactContextInput } from "./tools/compactContext"
 * @import { ExecCommandInput } from "./tools/execCommand"
 * @import { PatchBlock, PatchFileInput } from "./tools/patchFile"
 * @import { ReadFileInput } from "./tools/readFile"
 * @import { WriteFileInput } from "./tools/writeFile"
 * @import { TmuxCommandInput } from "./tools/tmuxCommand"
 * @import { SwitchToSubagentInput } from "./tools/switchToSubagent"
 */

import fs from "node:fs/promises";
import { styleText } from "node:util";
import { parseBlocks } from "./tools/patchFile.mjs";
import { diffLines } from "./utils/diffLines.mjs";
import { noThrow } from "./utils/noThrow.mjs";

/** Length above which a single-line arg forces block-form rendering. */
const ARG_BLOCK_LENGTH_THRESHOLD = 60;

/**
 * Format an args array for display.
 * Uses compact JSON for short single-line args; switches to a YAML-style
 * block form when any arg contains newlines or exceeds
 * {@link ARG_BLOCK_LENGTH_THRESHOLD} characters so that long scripts passed
 * to `bash -c`, `python -c`, `node -e`, etc. stay readable.
 * @param {unknown} args
 * @returns {string}
 */
export function formatArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return `args: ${JSON.stringify(args ?? [])}`;
  }

  const needsBlock = args.some(
    (a) =>
      typeof a === "string" &&
      (a.includes("\n") || a.length > ARG_BLOCK_LENGTH_THRESHOLD),
  );
  if (!needsBlock) {
    return `args: ${JSON.stringify(args)}`;
  }

  const lines = ["args:"];
  for (const arg of args) {
    if (
      typeof arg === "string" &&
      (arg.includes("\n") || arg.length > ARG_BLOCK_LENGTH_THRESHOLD)
    ) {
      lines.push("  - |");
      for (const line of arg.split("\n")) {
        lines.push(`      ${line}`);
      }
    } else {
      lines.push(`  - ${JSON.stringify(arg)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Format tool use for display.
 * @param {MessageContentToolUse} toolUse
 * @returns {Promise<string>}
 */
export async function formatToolUse(toolUse) {
  const { toolName, input } = toolUse;

  if (toolName === "exec_command") {
    /** @type {Partial<ExecCommandInput>} */
    const execCommandInput = input;
    return [
      `tool: ${toolName}`,
      `command: ${JSON.stringify(execCommandInput.command)}`,
      formatArgs(execCommandInput.args),
    ].join("\n");
  }

  if (toolName === "write_file") {
    /** @type {Partial<WriteFileInput>} */
    const writeFileInput = input;
    return [
      `tool: ${toolName}`,
      `filePath: ${writeFileInput.filePath}`,
      `content:\n${writeFileInput.content}`,
    ].join("\n");
  }

  if (toolName === "patch_file") {
    /** @type {Partial<PatchFileInput>} */
    const patchFileInput = input;
    const filePath = patchFileInput.filePath ?? "";
    const diff = patchFileInput.diff || "";
    const rendered = await renderPatchDiff(filePath, diff);
    return [
      `tool: ${toolName}`,
      `path: ${filePath}`,
      `diff:\n${rendered}`,
    ].join("\n");
  }

  if (toolName === "read_file") {
    /** @type {Partial<ReadFileInput>} */
    const readFileInput = input;
    /** @type {string[]} */
    const lines = [`tool: ${toolName}`, `filePath: ${readFileInput.filePath}`];
    if (readFileInput.offset !== undefined) {
      lines.push(`offset: ${readFileInput.offset}`);
    }
    if (readFileInput.limit !== undefined) {
      lines.push(`limit: ${readFileInput.limit}`);
    }
    return lines.join("\n");
  }

  if (toolName === "tmux_command") {
    /** @type {Partial<TmuxCommandInput>} */
    const tmuxCommandInput = input;
    return [
      `tool: ${toolName}`,
      `command: ${tmuxCommandInput.command}`,
      formatArgs(tmuxCommandInput.args),
    ].join("\n");
  }

  if (toolName === "switch_to_subagent") {
    /** @type {Partial<SwitchToSubagentInput>} */
    const switchToSubagentInput = input;
    return [
      `tool: ${toolName}`,
      `name: ${switchToSubagentInput.name}`,
      `goal: ${switchToSubagentInput.goal}`,
    ].join("\n");
  }

  if (toolName === "compact_context") {
    /** @type {Partial<CompactContextInput>} */
    const compactContextInput = input;
    return [
      `tool: ${toolName}`,
      `memoryPath: ${compactContextInput.memoryPath}`,
      `reason: ${compactContextInput.reason}`,
    ].join("\n");
  }

  if (toolName === "switch_to_main_agent") {
    /** @type {Partial<import("./tools/switchToMainAgent").SwitchToMainAgentInput>} */
    const switchToMainAgentInput = input;
    return [
      `tool: ${toolName}`,
      `memoryPath: ${switchToMainAgentInput.memoryPath}`,
    ].join("\n");
  }

  if (toolName === "ask_web") {
    /** @type {Partial<import("./tools/askWeb.mjs").AskWebInput>} */
    const askWebInput = input;
    return [`tool: ${toolName}`, `question: ${askWebInput.question}`].join(
      "\n",
    );
  }

  if (toolName === "ask_url") {
    /** @type {Partial<import("./tools/askURL.mjs").AskURLInput>} */
    const askURLInput = input;
    return [`tool: ${toolName}`, `question: ${askURLInput.question}`].join(
      "\n",
    );
  }

  const { provider: _, ...filteredToolUse } = toolUse;

  return JSON.stringify(filteredToolUse, null, 2);
}

/** Maximum length of output to display */
const MAX_DISPLAY_OUTPUT_LENGTH = 1024;

/**
 * Format tool result for display.
 * @param {MessageContentToolResult} toolResult
 * @returns {string}
 */
export function formatToolResult(toolResult) {
  const { content, isError } = toolResult;

  /** @type {string[]} */
  const contentStringParts = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        contentStringParts.push(part.text);
        break;
      case "image":
        contentStringParts.push(
          `data:${part.mimeType};base64,${part.data.slice(0, 20)}...`,
        );
        break;
      default:
        console.log(`Unsupported content part: ${JSON.stringify(part)}`);
        break;
    }
  }

  const contentString = contentStringParts.join("\n\n");

  if (isError) {
    return styleText("red", contentString);
  }

  if (toolResult.toolName === "exec_command") {
    return contentString
      .replace(/(^<stdout>|<\/stdout>$)/gm, styleText("blue", "$1"))
      .replace(
        /(<truncated_output.+?>|<\/truncated_output>)/g,
        styleText("yellow", "$1"),
      )
      .replace(/(^<stderr>|<\/stderr>$)/gm, styleText("magenta", "$1"))
      .replace(/(^<error>|<\/error>$)/gm, styleText("red", "$1"));
  }

  if (toolResult.toolName === "tmux_command") {
    return contentString
      .replace(/(^<stdout>|<\/stdout>$)/gm, styleText("blue", "$1"))
      .replace(/(^<stderr>|<\/stderr>$)/gm, styleText("magenta", "$1"))
      .replace(/(^<error>|<\/error>$)/gm, styleText("red", "$1"))
      .replace(/(^<tmux:.*?>|<\/tmux:.*?>$)/gm, styleText("green", "$1"));
  }

  if (contentString.length > MAX_DISPLAY_OUTPUT_LENGTH) {
    return [
      contentString.slice(0, MAX_DISPLAY_OUTPUT_LENGTH),
      styleText("yellow", "... (Output truncated for display)"),
      "\n",
    ].join("");
  }

  return contentString;
}

/**
 * Format provider token usage for display.
 * @param {ProviderTokenUsage} usage
 * @returns {string}
 */
export function formatProviderTokenUsage(usage) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const header = [];
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") {
      header.push(`${key}: ${value}`);
    } else if (typeof value === "string") {
      header.push(`${key}: ${value}`);
    } else if (value) {
      lines.push(
        `(${key}) ${Object.entries(value)
          .filter(
            ([k]) =>
              ![
                // OpenAI
                "audio_tokens",
                "accepted_prediction_tokens",
                "rejected_prediction_tokens",
              ].includes(k),
          )
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(", ")}`,
      );
    }
  }

  const outputLines = [`\n${header.join(", ")}`];

  if (lines.length) {
    outputLines.push(lines.join(" / "));
  }

  return styleText("gray", outputLines.join("\n"));
}

/**
 * Format cost summary for interactive display
 * @param {import("./costTracker.mjs").CostSummary} summary
 * @returns {string}
 */
export function formatCostSummary(summary) {
  if (!summary || Object.keys(summary.breakdown).length === 0) {
    return styleText("gray", "No token usage recorded yet.");
  }

  const lines = [];

  if (summary.totalCost !== undefined) {
    lines.push(
      styleText(
        "bold",
        `\nTotal: ${summary.totalCost.toFixed(4)} ${summary.currency}`,
      ),
    );
  } else {
    lines.push(styleText("yellow", "Total: N/A (no cost configuration)"));
  }

  lines.push(styleText("bold", "\nTokens:"));
  for (const [key, { tokens, cost }] of Object.entries(summary.breakdown)) {
    const tokenStr = `${key}: ${tokens.toLocaleString()}`;

    if (cost !== undefined) {
      const costStr = `${cost.toFixed(4)} ${summary.currency}`;
      lines.push(`  ${tokenStr.padEnd(30)} ${styleText("cyan", costStr)}`);
    } else {
      lines.push(`  ${tokenStr.padEnd(30)} ${styleText("gray", "N/A")}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format cost for batch mode JSON output
 * @param {import("./costTracker.mjs").CostSummary} summary
 */
export function formatCostForBatch(summary) {
  if (!summary || Object.keys(summary.breakdown).length === 0) {
    return undefined;
  }

  return {
    total: summary.totalCost,
    currency: summary.currency,
    unit: summary.unit,
    breakdown: Object.fromEntries(
      Object.entries(summary.breakdown).map(([key, { tokens, cost }]) => [
        key,
        { tokens, cost },
      ]),
    ),
  };
}

/**
 * Print a message to the console.
 * @param {Message} message
 * @returns {Promise<void>}
 */
export async function printMessage(message) {
  switch (message.role) {
    case "assistant": {
      // console.log(styleText("bold", "\nAgent:"));
      // Pre-format all tool_use parts in parallel to avoid sequential awaits
      const toolUseParts = message.content.filter(
        (part) => part.type === "tool_use",
      );
      const formattedToolUses = await Promise.all(
        toolUseParts.map((part) => formatToolUse(part)),
      );
      let toolUseIndex = 0;
      for (const part of message.content) {
        switch (part.type) {
          // Note: Streamで表示するためここでは表示しない
          // case "thinking":
          //   console.log(
          //     [
          //       styleText("blue", "<thinking>"),
          //       part.thinking,
          //       styleText("blue", "</thinking>\n"),
          //     ].join("\n"),
          //   );
          //   break;
          // case "text":
          //   console.log(part.text);
          //   break;
          case "tool_use":
            console.log(styleText("bold", "\nTool call:"));
            console.log(formattedToolUses[toolUseIndex++]);
            break;
        }
      }
      break;
    }
    case "user": {
      for (const part of message.content) {
        switch (part.type) {
          case "tool_result": {
            console.log(styleText("bold", "\nTool result:"));
            console.log(formatToolResult(part));
            break;
          }
          case "text": {
            console.log(styleText("bold", "\nUser:"));
            const highlighted = part.text.replace(
              /^(<context.+?>|<\/context>)/gm,
              styleText("green", "$1"),
            );
            console.log(highlighted);
            break;
          }
          case "image": {
            break;
          }
          default: {
            console.log(styleText("bold", "\nUnknown Message Format:"));
            console.log(JSON.stringify(part, null, 2));
          }
        }
      }
      break;
    }
    default: {
      console.log(styleText("bold", "\nUnknown Message Format:"));
      console.log(JSON.stringify(message, null, 2));
    }
  }
}

/**
 * Render patch_file diff for terminal display.
 *
 * Best-effort: parses the diff and reads the target file so the original
 * lines targeted by each block can be shown alongside the new content
 * (`-` red for removed, `+` green for added). Falls back to a verbatim
 * highlight (open/close markers cyan, body lines green) on any failure
 * (empty diff, missing nonce, parse error, file unreadable, etc.).
 *
 * @param {string} filePath
 * @param {string} diff
 * @returns {Promise<string>}
 */
async function renderPatchDiff(filePath, diff) {
  if (!diff) {
    return "";
  }
  const fallback = highlightPatchDiffPlain(diff);

  const nonce = extractPatchNonce(diff);
  if (!nonce) {
    return fallback;
  }

  /** @type {PatchBlock[]} */
  let blocks;
  try {
    blocks = parseBlocks(diff, nonce);
  } catch {
    return fallback;
  }

  let originalLines = null;
  if (filePath) {
    const original = await noThrow(() => fs.readFile(filePath, "utf8"));
    if (!(original instanceof Error)) {
      originalLines = splitContentLines(original);
    }
  }

  return blocks
    .map((block) => renderPatchBlock(block, originalLines, nonce))
    .join("\n\n");
}

/**
 * @param {PatchBlock} block
 * @param {string[] | null} originalLines
 * @param {string} nonce
 * @returns {string}
 */
function renderPatchBlock(block, originalLines, nonce) {
  /** @type {string[]} */
  const out = [];
  if (block.op === "replace") {
    const head = block.head !== undefined ? ` HEAD=${block.head}` : "";
    out.push(
      styleText("cyan", `@@@ ${nonce} ${block.start}-${block.end}${head}`),
    );
    if (originalLines) {
      const safeStart = Math.max(1, block.start);
      const safeEnd = Math.min(originalLines.length, block.end);
      const oldSlice = originalLines.slice(safeStart - 1, safeEnd);
      // Use a real line diff so unchanged lines render as context
      // (no color, " " prefix) instead of being shown as both "- " and
      // "+ ".
      for (const op of diffLines(oldSlice, block.body)) {
        if (op.type === "-") {
          out.push(styleText("red", `- ${op.line}`));
        } else if (op.type === "+") {
          out.push(styleText("green", `+ ${op.line}`));
        } else {
          out.push(`  ${op.line}`);
        }
      }
    } else {
      // No file context available — fall back to listing the body as
      // additions so the user can still see the new content.
      for (const line of block.body) {
        out.push(styleText("green", `+ ${line}`));
      }
    }
  } else {
    out.push(styleText("cyan", `@@@ ${nonce} ${block.after}+`));
    for (const line of block.body) {
      out.push(styleText("green", `+ ${line}`));
    }
  }
  out.push(styleText("cyan", `@@@ ${nonce}`));
  return out.join("\n");
}

/**
 * Verbatim highlighter used as fallback when block-aware rendering is not
 * possible (parse error, missing nonce, etc.).
 * @param {string} diff
 * @returns {string}
 */
function highlightPatchDiffPlain(diff) {
  if (!diff) {
    return "";
  }
  // Patch headers/closes look like "@@@ <nonce> ..." or "@@@ <nonce>".
  const headerRegex = /^@@@\s+\S+(\s.*)?$/;
  return diff
    .split("\n")
    .map((line) => {
      if (headerRegex.test(line)) {
        return styleText("cyan", line);
      }
      if (line === "") {
        return line;
      }
      return styleText("green", line);
    })
    .join("\n");
}

/**
 * Extract the nonce from the first open marker in a patch_file diff.
 * @param {string} diff
 * @returns {string | null}
 */
function extractPatchNonce(diff) {
  const match = diff.match(/^@@@\s+(\S+)/m);
  return match ? match[1] : null;
}

/**
 * Split file content into lines, dropping the trailing empty element when
 * the file ends with a newline (matches patch_file's own line indexing).
 * @param {string} content
 * @returns {string[]}
 */
function splitContentLines(content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
