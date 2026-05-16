/**
 * @import { Message, MessageContentToolUse, MessageContentToolResult, ProviderTokenUsage } from "../model"
 * @import { CompactContextInput } from "../tools/compactContext"
 * @import { ExecCommandInput } from "../tools/execCommand"
 * @import { PatchBlock, PatchFileInput } from "../tools/patchFile"
 * @import { ReadFileInput } from "../tools/readFile"
 * @import { WriteFileInput } from "../tools/writeFile"
 * @import { TmuxCommandInput } from "../tools/tmuxCommand"
 * @import { SwitchToSubagentInput } from "../tools/switchToSubagent"
 */

import fs from "node:fs/promises";
import { styleText } from "node:util";
import { parseBlocks } from "../tools/patchFile.mjs";
import { diffLines } from "../utils/diffLines.mjs";
import { noThrow } from "../utils/noThrow.mjs";

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
    const patch = patchFileInput.patch || "";
    const rendered = await renderPatch(filePath, patch);
    return [
      `tool: ${toolName}`,
      `path: ${filePath}`,
      `patch:\n${rendered}`,
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
    /** @type {Partial<import("../tools/switchToMainAgent").SwitchToMainAgentInput>} */
    const switchToMainAgentInput = input;
    return [
      `tool: ${toolName}`,
      `memoryPath: ${switchToMainAgentInput.memoryPath}`,
    ].join("\n");
  }

  if (toolName === "web_search") {
    /** @type {Partial<import("../tools/webSearch.mjs").WebSearchInput>} */
    const webSearchInput = input;
    const searchesLine = webSearchInput.searches
      ? webSearchInput.searches.map((s) => s.keywords.join(" ")).join(" | ")
      : "";
    return [
      `tool: ${toolName}`,
      `searches: ${searchesLine}`,
      `question: ${webSearchInput.question}`,
    ].join("\n");
  }

  if (toolName === "web_fetch") {
    /** @type {Partial<import("../tools/webFetch.mjs").WebFetchInput>} */
    const webFetchInput = input;
    return [
      `tool: ${toolName}`,
      `url: ${webFetchInput.url}`,
      `question: ${webFetchInput.question}`,
    ].join("\n");
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

  if (toolResult.toolName === "read_file") {
    return contentString.replace(
      /^(\s*\d+:[0-9a-f]{2}\|)/gm,
      styleText("gray", "$1"),
    );
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
 * @param {import("../costTracker.mjs").CostSummary} summary
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
 * @param {import("../costTracker.mjs").CostSummary} summary
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
 * Format markdown table lines with aligned columns.
 * Input lines may have leading/trailing pipes.
 * Output always has leading and trailing pipes with padded cells.
 * @param {string[]} lines - Raw table lines (including alignment row)
 * @returns {string} - Formatted table string with aligned columns
 */
export function formatMarkdownTable(lines) {
  if (lines.length === 0) return "";

  const rows = lines.map(splitTableRow);

  // Calculate max display width for each column
  const colCount = Math.max(...rows.map((r) => r.length));
  /** @type {number[]} */
  const colWidths = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const width = charDisplayWidth(row[i]);
      if (width > colWidths[i]) {
        colWidths[i] = width;
      }
    }
  }

  // Pad each cell and join
  return rows
    .map((row) => {
      // Pad row to column count with empty cells
      const fullRow = row.concat(new Array(colCount - row.length).fill(""));
      const padded = fullRow.map((cell, i) => padCell(cell, colWidths[i] ?? 0));
      return `| ${padded.join(" | ")} |`;
    })
    .join("\n");
}

/** @type {RegExp} - ANSI escape code pattern */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape code pattern
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/**
 * Strip ANSI escape codes for display width calculation.
 * @param {string} str
 * @returns {string}
 */
function stripAnsiCodes(str) {
  return str.replace(ANSI_RE, "");
}

/**
 * Calculate the terminal display width of a string.
 * CJK full-width characters and emoji count as 2 columns; ASCII as 1.
 * ANSI escape codes are stripped before measurement.
 * @param {string} str
 * @returns {number}
 */
function charDisplayWidth(str) {
  const plain = stripAnsiCodes(str);
  let width = 0;
  for (const ch of plain) {
    const code = /** @type {number} */ (ch.codePointAt(0));
    if (
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK Radicals Supplement ... Yi
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
      (code >= 0xfe10 && code <= 0xfe19) || // Vertical forms
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth Signs
      // Miscellaneous Symbols (Wide only per UAX #11)
      (code >= 0x2614 && code <= 0x2615) ||
      (code >= 0x2630 && code <= 0x2637) ||
      (code >= 0x2648 && code <= 0x2653) ||
      code === 0x267f ||
      (code >= 0x268a && code <= 0x268f) ||
      code === 0x2693 ||
      code === 0x26a1 ||
      (code >= 0x26aa && code <= 0x26ab) ||
      (code >= 0x26bd && code <= 0x26be) ||
      (code >= 0x26c4 && code <= 0x26c5) ||
      code === 0x26ce ||
      code === 0x26d4 ||
      code === 0x26ea ||
      (code >= 0x26f2 && code <= 0x26f3) ||
      code === 0x26f5 ||
      code === 0x26fa ||
      code === 0x26fd ||
      // Dingbats (Wide only per UAX #11)
      code === 0x2705 ||
      (code >= 0x270a && code <= 0x270b) ||
      code === 0x2728 ||
      code === 0x274c ||
      code === 0x274e ||
      (code >= 0x2753 && code <= 0x2755) ||
      code === 0x2757 ||
      (code >= 0x2795 && code <= 0x2797) ||
      code === 0x27b0 ||
      code === 0x27bf ||
      // Miscellaneous Symbols and Arrows (Wide only per UAX #11)
      (code >= 0x2b1b && code <= 0x2b1c) ||
      code === 0x2b50 ||
      code === 0x2b55 ||
      // Miscellaneous Technical (Wide only per UAX #11)
      (code >= 0x231a && code <= 0x231b) ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x23e9 && code <= 0x23ec) ||
      code === 0x23f0 ||
      code === 0x23f3 ||
      // Emoji ranges (Wide only per UAX #11)
      code === 0x1f004 ||
      code === 0x1f0cf ||
      code === 0x1f18e ||
      (code >= 0x1f191 && code <= 0x1f19a) ||
      (code >= 0x1f200 && code <= 0x1f202) ||
      (code >= 0x1f210 && code <= 0x1f23b) ||
      (code >= 0x1f240 && code <= 0x1f248) ||
      (code >= 0x1f250 && code <= 0x1f251) ||
      (code >= 0x1f260 && code <= 0x1f265) ||
      (code >= 0x1f300 && code <= 0x1f320) ||
      (code >= 0x1f32d && code <= 0x1f335) ||
      (code >= 0x1f337 && code <= 0x1f37c) ||
      (code >= 0x1f37e && code <= 0x1f393) ||
      (code >= 0x1f3a0 && code <= 0x1f3ca) ||
      (code >= 0x1f3cf && code <= 0x1f3d3) ||
      (code >= 0x1f3e0 && code <= 0x1f3f0) ||
      code === 0x1f3f4 ||
      (code >= 0x1f3f8 && code <= 0x1f3fa) ||
      (code >= 0x1f3fb && code <= 0x1f3ff) ||
      (code >= 0x1f400 && code <= 0x1f43e) ||
      code === 0x1f440 ||
      (code >= 0x1f442 && code <= 0x1f4fc) ||
      (code >= 0x1f4ff && code <= 0x1f53d) ||
      (code >= 0x1f54b && code <= 0x1f54e) ||
      (code >= 0x1f550 && code <= 0x1f567) ||
      code === 0x1f57a ||
      (code >= 0x1f595 && code <= 0x1f596) ||
      code === 0x1f5a4 ||
      (code >= 0x1f5fb && code <= 0x1f5ff) ||
      (code >= 0x1f600 && code <= 0x1f64f) ||
      (code >= 0x1f680 && code <= 0x1f6c5) ||
      code === 0x1f6cc ||
      (code >= 0x1f6d0 && code <= 0x1f6d2) ||
      (code >= 0x1f6d5 && code <= 0x1f6d8) ||
      (code >= 0x1f6dc && code <= 0x1f6df) ||
      (code >= 0x1f6eb && code <= 0x1f6ec) ||
      (code >= 0x1f6f4 && code <= 0x1f6fc) ||
      (code >= 0x1f7e0 && code <= 0x1f7eb) ||
      code === 0x1f7f0 ||
      (code >= 0x1f90c && code <= 0x1f93a) ||
      (code >= 0x1f93c && code <= 0x1f945) ||
      (code >= 0x1f947 && code <= 0x1f9ff) ||
      (code >= 0x1fa70 && code <= 0x1fa7c) ||
      (code >= 0x1fa80 && code <= 0x1fa8a) ||
      (code >= 0x1fa8e && code <= 0x1fac6) ||
      code === 0x1fac8 ||
      (code >= 0x1facd && code <= 0x1fadc) ||
      (code >= 0x1fadf && code <= 0x1faea) ||
      (code >= 0x1faef && code <= 0x1faf8) ||
      (code >= 0x20000 && code <= 0x2fffd) || // CJK Unified Ext B+
      (code >= 0x30000 && code <= 0x3fffd) // CJK Unified Ext G+
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Split a markdown table row into cells.
 * Removes leading/trailing pipes, splits by `|`.
 * Respects escaped pipes (`\|`).
 * @param {string} line
 * @returns {string[]}
 */
function splitTableRow(line) {
  const trimmed = line.trim();
  // Remove leading and trailing pipes
  let inner;
  if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
    inner = trimmed.slice(1, -1);
  } else if (trimmed.startsWith("|")) {
    inner = trimmed.slice(1);
  } else if (trimmed.endsWith("|")) {
    inner = trimmed.slice(0, -1);
  } else {
    inner = trimmed;
  }

  // Split by pipe, respecting escaped pipes
  /** @type {string[]} */
  const cells = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && i + 1 < inner.length && inner[i + 1] === "|") {
      current += "|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(current);
      current = "";
    } else {
      current += inner[i];
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/**
 * Pad a cell string with trailing spaces to the given display width.
 * @param {string} cell - Original cell content (may contain ANSI codes)
 * @param {number} targetWidth - Target display width
 * @returns {string}
 */
function padCell(cell, targetWidth) {
  const currentWidth = charDisplayWidth(cell);
  if (currentWidth >= targetWidth) return cell;
  return cell + " ".repeat(targetWidth - currentWidth);
}

/**
 * Render a patch_file `patch` string for terminal display.
 *
 * Attempts to show a side-by-side diff (- removed, + added,   unchanged)
 * by parsing the patch and reading the target file. Falls back to plain
 * syntax highlighting on any failure.
 *
 * @param {string} filePath
 * @param {string} patch
 * @returns {Promise<string>}
 */
async function renderPatch(filePath, patch) {
  if (!patch) {
    return "";
  }
  const fallback = highlightPatchPlain(patch);

  const nonce = extractPatchNonce(patch);
  if (!nonce) {
    return fallback;
  }

  /** @type {PatchBlock[]} */
  let blocks;
  try {
    blocks = parseBlocks(patch, nonce);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      styleText("yellow", `Warning: Patch parsing failed: ${message}`),
    );
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
    out.push(
      styleText(
        "cyan",
        `@@@ ${nonce} ${block.start}:${block.startHash}-${block.end}:${block.endHash}`,
      ),
    );
    if (originalLines) {
      const safeStart = Math.max(1, block.start);
      const safeEnd = Math.min(originalLines.length, block.end);
      const oldSlice = originalLines.slice(safeStart - 1, safeEnd);
      // Use a real line diff so unchanged lines render as context
      // (no color, "  " prefix) instead of being shown as both "- " and
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
    const afterSuffix = block.afterHash ? `:${block.afterHash}` : "";
    out.push(styleText("cyan", `@@@ ${nonce} ${block.after}${afterSuffix}+`));
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
 * @param {string} patch
 * @returns {string}
 */
function highlightPatchPlain(patch) {
  if (!patch) {
    return "";
  }
  // Patch headers/closes look like "@@@ <nonce> ..." or "@@@ <nonce>".
  const headerRegex = /^@@@\s+\S+(\s.*)?$/;
  return patch
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
 * Extract the nonce from the first open marker in a patch_file patch.
 * @param {string} patch
 * @returns {string | null}
 */
function extractPatchNonce(patch) {
  const match = patch.match(/^@@@\s+(\S+)/m);
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
