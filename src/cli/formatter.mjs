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

/** Total JSON length above which args are rendered in block form even if each individual arg is short. */
const ARGS_TOTAL_BLOCK_LENGTH_THRESHOLD = 160;

/**
 * Format an args array for display.
 * Uses compact JSON for short single-line args; switches to a YAML-style
 * block form when any arg contains newlines or exceeds
 * {@link ARG_BLOCK_LENGTH_THRESHOLD} characters so that long scripts passed
 * to `bash -c`, `python -c`, `node -e`, etc. stay readable.
 * @param {unknown} args
 * @returns {string}
 */
export function formatCommandArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return `args: ${JSON.stringify(args ?? [])}`;
  }

  const needsBlock =
    JSON.stringify(args).length > ARGS_TOTAL_BLOCK_LENGTH_THRESHOLD ||
    args.some(
      (a) =>
        typeof a === "string" &&
        (a.includes("\n") || a.length > ARG_BLOCK_LENGTH_THRESHOLD),
    );
  if (!needsBlock) {
    return `args: ${highlightCommandArgs(JSON.stringify(args))}`;
  }

  const lines = ["args:"];
  for (const arg of args) {
    if (
      typeof arg === "string" &&
      (arg.includes("\n") || arg.length > ARG_BLOCK_LENGTH_THRESHOLD)
    ) {
      lines.push("  - |");
      for (const line of arg.split("\n")) {
        lines.push(`      ${highlightCommandArgs(line)}`);
      }
    } else {
      lines.push(`  - ${highlightCommandArgs(JSON.stringify(arg))}`);
    }
  }
  return lines.join("\n");
}

/**
 * @param {string} args
 * @returns {string}
 */
function highlightCommandArgs(args) {
  return (
    args
      // --foo
      .replace(
        /(^|\s|")(--[a-zA-Z0-9-]+)(\s|"|$)/gm,
        (_, p1, p2, p3) => p1 + styleText("cyan", p2) + p3,
      )
      // -f
      .replace(
        /(^|\s|")(-[a-zA-Z]+)(\s|"|$)/gm,
        (_, p1, p2, p3) => p1 + styleText("cyan", p2) + p3,
      )
  );
}

/**
 * @import { SandboxModeProvider } from "../tool"
 */

/**
 * Format tool use for display.
 * @param {MessageContentToolUse} toolUse
 * @param {{ execCommandTool?: SandboxModeProvider }} [options]
 * @returns {Promise<string>}
 */
export async function formatToolUse(toolUse, options = {}) {
  const { toolName, input } = toolUse;

  if (toolName === "exec_command") {
    /** @type {Partial<ExecCommandInput>} */
    const execCommandInput = input;
    const mode = options.execCommandTool?.getSandboxMode?.(input);
    const toolNameLine =
      mode === "unsandboxed"
        ? `${toolName}${styleText("yellow", " [unsandboxed]")}`
        : toolName;
    return [
      toolNameLine,
      `command: ${JSON.stringify(execCommandInput.command)}`,
      formatCommandArgs(execCommandInput.args),
    ].join("\n");
  }

  if (toolName === "write_file") {
    /** @type {Partial<WriteFileInput>} */
    const writeFileInput = input;
    return [
      `${toolName}`,
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
    return [`${toolName}`, `path: ${filePath}`, `patch:\n${rendered}`].join(
      "\n",
    );
  }

  if (toolName === "read_file") {
    /** @type {Partial<ReadFileInput>} */
    const readFileInput = input;
    /** @type {string[]} */
    const lines = [`${toolName}`, `filePath: ${readFileInput.filePath}`];
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
      `${toolName}`,
      `command: ${tmuxCommandInput.command}`,
      formatCommandArgs(tmuxCommandInput.args),
    ].join("\n");
  }

  if (toolName === "switch_to_subagent") {
    /** @type {Partial<SwitchToSubagentInput>} */
    const switchToSubagentInput = input;
    return [
      `${toolName}`,
      `name: ${switchToSubagentInput.name}`,
      `goal: ${switchToSubagentInput.goal}`,
    ].join("\n");
  }

  if (toolName === "compact_context") {
    /** @type {Partial<CompactContextInput>} */
    const compactContextInput = input;
    return [
      `${toolName}`,
      `memoryPath: ${compactContextInput.memoryPath}`,
      `reason: ${compactContextInput.reason}`,
    ].join("\n");
  }

  if (toolName === "switch_to_main_agent") {
    /** @type {Partial<import("../tools/switchToMainAgent").SwitchToMainAgentInput>} */
    const switchToMainAgentInput = input;
    return [
      `${toolName}`,
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
      `${toolName}`,
      `searches: ${searchesLine}`,
      `question: ${webSearchInput.question}`,
    ].join("\n");
  }

  if (toolName === "web_fetch") {
    /** @type {Partial<import("../tools/webFetch.mjs").WebFetchInput>} */
    const webFetchInput = input;
    return [
      `${toolName}`,
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
    return styleText("magenta", contentString);
  }

  if (toolResult.toolName === "exec_command") {
    return contentString
      .replace(/(^<stdout>|<\/stdout>$)/gm, styleText("blue", "$1"))
      .replace(
        /(<truncated_output.+?>|<\/truncated_output>)/g,
        styleText("yellow", "$1"),
      )
      .replace(/(^<stderr>|<\/stderr>$)/gm, styleText("magenta", "$1"))
      .replace(/(^<error code=.+?>|<\/error>$)/gm, styleText("magenta", "$1"));
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
      .replace(/(^<error>|<\/error>$)/gm, styleText("magenta", "$1"))
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
 * @param {{ execCommandTool?: SandboxModeProvider }} [options]
 * @returns {Promise<void>}
 */
export async function printMessage(message, options = {}) {
  switch (message.role) {
    case "assistant": {
      // console.log(styleText("bold", "\nAgent:"));
      // Pre-format all tool_use parts in parallel to avoid sequential awaits
      const toolUseParts = message.content.filter(
        (part) => part.type === "tool_use",
      );
      const formattedToolUses = await Promise.all(
        toolUseParts.map((part) => formatToolUse(part, options)),
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
            console.log(styleText("bold", "\nTool use:"));
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
 * Convert **bold** Markdown to ANSI bold terminal escape codes.
 * Only matches when ** is preceded by whitespace or line start
 * and followed by whitespace, line end, or punctuation — so inline
 * code like `**bold**` is left untouched.
 * @param {string} text
 * @returns {string}
 */
export function applyInlineMarkdown(text) {
  return text.replace(
    /(?<=\s|^)\*\*(.+?)\*\*(?=[\s.,;:!?)〕）】」』]|$)/g,
    (_, c) => styleText("bold", c),
  );
}

/**
 * Format markdown table lines with aligned columns.
 * Input lines may have leading/trailing pipes.
 * Output always has leading and trailing pipes with padded cells.
 * When the table would exceed `maxWidth`, long cells are wrapped onto
 * additional visual lines so the table stays within the terminal width.
 * @param {string[]} lines - Raw table lines (including alignment row)
 * @param {number} [maxWidth=Infinity] - Maximum terminal display width
 * @returns {string} - Formatted table string with aligned columns
 */
export function formatMarkdownTable(
  lines,
  maxWidth = Number.POSITIVE_INFINITY,
) {
  if (lines.length === 0) return "";

  const rows = lines.map(splitTableRow);

  // Calculate max display width for each column (natural width)
  const colCount = Math.max(...rows.map((r) => r.length));
  /** @type {number[]} */
  const naturalWidths = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const width = charDisplayWidth(row[i]);
      if (width > naturalWidths[i]) {
        naturalWidths[i] = width;
      }
    }
  }

  // Determine column widths that fit within maxWidth
  const colWidths = fitColumns(naturalWidths, colCount, maxWidth);

  // Check if wrapping is needed (any column was shrunk)
  const needsWrapping = colWidths.some((w, i) => w < naturalWidths[i]);

  if (!needsWrapping) {
    // Original path: no wrapping, just pad and join
    return rows
      .map((row) => {
        const fullRow = row.concat(new Array(colCount - row.length).fill(""));
        const padded = fullRow.map((cell, i) =>
          padCell(cell, colWidths[i] ?? 0),
        );
        return `| ${padded.join(" | ")} |`;
      })
      .join("\n");
  }

  // Wrapped path: wrap cells and render multi-line rows
  const wrappedRows = rows.map((row) => {
    const fullRow = row.concat(new Array(colCount - row.length).fill(""));
    const isSeparator = isSeparatorRow(fullRow);
    return fullRow.map((cell, i) => {
      if (isSeparator) {
        // Regenerate separator dashes to fit the column width (no wrapping)
        return ["-".repeat(colWidths[i])];
      }
      return wrapCell(cell, colWidths[i]);
    });
  });

  return wrappedRows
    .map((wrappedCells) => renderWrappedRow(wrappedCells, colWidths))
    .join("\n");
}

/**
 * Check if a row is a markdown table separator row.
 * A separator row contains only dashes, colons, and spaces
 * (e.g., "------", ":----:", "-----:", ":-----").
 * @param {string[]} cells
 * @returns {boolean}
 */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^[-: ]+$/.test(cell));
}

/**
 * Determine column widths that fit within maxWidth.
 * If the natural total width fits, returns natural widths unchanged.
 * Otherwise, shrinks columns proportionally (minimum 3 chars each).
 * Returns null in any entry if the table cannot fit at all (fallback signal).
 * @param {number[]} naturalWidths - Natural (max content) width per column
 * @param {number} colCount - Number of columns
 * @param {number} maxWidth - Available terminal width
 * @returns {number[]} - Target width per column
 */
function fitColumns(naturalWidths, colCount, maxWidth) {
  const gutter = 4 + (colCount - 1) * 3; // "| " + " |" + inter-column " | "
  const available = maxWidth - gutter;

  // If natural widths fit, use them as-is
  const totalNatural = naturalWidths.reduce((s, w) => s + w, 0);
  if (totalNatural <= available || maxWidth === Number.POSITIVE_INFINITY) {
    return naturalWidths;
  }

  // Shrink: allocate minimum width first, then distribute remainder proportionally
  const minWidth = 3;
  const minTotal = minWidth * colCount;

  if (minTotal > available) {
    // Cannot fit even at minimum — return natural widths (will overflow)
    return naturalWidths;
  }

  const result = naturalWidths.map(() => minWidth);
  const remaining = available - minTotal;

  // Distribute remaining space proportionally to natural widths
  const naturalTotalAboveMin = naturalWidths.reduce(
    (s, w) => s + Math.max(0, w - minWidth),
    0,
  );

  if (naturalTotalAboveMin > 0) {
    for (let i = 0; i < colCount; i++) {
      const aboveMin = Math.max(0, naturalWidths[i] - minWidth);
      const share = Math.round((aboveMin / naturalTotalAboveMin) * remaining);
      result[i] = minWidth + share;
    }

    // Adjust for rounding: distribute leftover pixels to widest columns
    const currentTotal = result.reduce((s, w) => s + w, 0);
    let diff = available - currentTotal;
    // Sort column indices by natural width descending for fair distribution
    const sortedIndices = naturalWidths
      .map((w, i) => /** @type {[number, number]} */ ([i, w]))
      .sort((a, b) => b[1] - a[1])
      .map(([i]) => i);
    let idx = 0;
    while (diff > 0) {
      result[sortedIndices[idx % colCount]]++;
      diff--;
      idx++;
    }
    while (diff < 0) {
      result[sortedIndices[idx % colCount]]--;
      diff++;
      idx++;
    }
  }

  return result;
}

/**
 * Wrap a cell's content to fit within the given display width.
 * Respects ANSI escape codes (does not break them) and CJK wide characters.
 * @param {string} text - Cell content (may contain ANSI codes)
 * @param {number} width - Maximum display width per line
 * @returns {string[]} - Array of visual lines for this cell
 */
function wrapCell(text, width) {
  if (width <= 0) return [text];
  const textWidth = charDisplayWidth(text);
  if (textWidth <= width) return [text];

  // Build segments: each segment is either an ANSI escape code or a visible character
  /** @type {{ text: string, displayWidth: number }[]} */
  const segments = [];
  let i = 0;
  while (i < text.length) {
    // Check for ANSI escape sequence
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape code pattern
    const ansiMatch = text.slice(i).match(/^\u001b\[[0-9;]*m/);
    if (ansiMatch) {
      segments.push({ text: ansiMatch[0], displayWidth: 0 });
      i += ansiMatch[0].length;
    } else {
      const ch = text[i];
      const code = /** @type {number} */ (ch.codePointAt(0));
      const isWide = isWideChar(code);
      segments.push({ text: ch, displayWidth: isWide ? 2 : 1 });
      i++;
    }
  }

  // Group segments into lines
  /** @type {string[]} */
  const lines = [];
  /** @type {string} */
  let currentLine = "";
  let currentWidth = 0;

  for (const seg of segments) {
    if (seg.displayWidth === 0) {
      // ANSI code: attach to current line without increasing width
      currentLine += seg.text;
      continue;
    }

    if (currentWidth + seg.displayWidth > width) {
      // This character would overflow — start a new line
      lines.push(currentLine);
      currentLine = seg.text;
      currentWidth = seg.displayWidth;
    } else {
      currentLine += seg.text;
      currentWidth += seg.displayWidth;
    }
  }

  if (currentLine.length > 0 || lines.length === 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Sorted, merged [start, end] ranges of Unicode code points with
 * East_Asian_Width property "W" (Wide) or "F" (Fullwidth).
 *
 * Generated by: node scripts/fetchEastAsianWideRanges.mjs
 * Source: https://www.unicode.org/Public/16.0.0/ucd/EastAsianWidth.txt
 */
import WIDE_RANGES from "./eastAsianWideRanges.json" with { type: "json" };

/**
 * Check if a Unicode code point is a wide (double-width) character.
 * Uses binary search over the sorted WIDE_RANGES for efficiency.
 * @param {number} code
 * @returns {boolean}
 */
function isWideChar(code) {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [start, end] = WIDE_RANGES[mid];
    if (code < start) hi = mid - 1;
    else if (code > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Render a wrapped row (where cells may span multiple visual lines).
 * Each cell's visual lines are padded to the column width, and cells
 * are aligned horizontally across visual lines.
 * @param {string[][]} wrappedCells - Array of visual-line arrays per cell
 * @param {number[]} colWidths - Target display width per column
 * @returns {string} - Rendered row (may contain embedded newlines)
 */
function renderWrappedRow(wrappedCells, colWidths) {
  const maxLines = Math.max(...wrappedCells.map((c) => c.length));
  const visualLines = [];
  for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
    const parts = wrappedCells.map((cell, colIdx) => {
      const text = cell[lineIdx] ?? "";
      return padCell(text, colWidths[colIdx]);
    });
    visualLines.push(`| ${parts.join(" | ")} |`);
  }
  return visualLines.join("\n");
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
    width += isWideChar(code) ? 2 : 1;
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
        `REPLACE ${nonce} ${block.start}:${block.startHash}-${block.end}:${block.endHash}`,
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
          out.push(styleText("magenta", `- ${op.line}`));
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
    out.push(
      styleText("cyan", `INSERT_AFTER ${nonce} ${block.after}${afterSuffix}`),
    );
    for (const line of block.body) {
      out.push(styleText("green", `+ ${line}`));
    }
  }
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
  // Patch headers look like "REPLACE <nonce> ..." or "INSERT_AFTER <nonce> ...".
  const headerRegex = /^(REPLACE|INSERT_AFTER)\s+\S+(\s.*)?$/;
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
  const match = patch.match(/^(REPLACE|INSERT_AFTER)\s+(\S+)/m);
  return match ? match[2] : null;
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
