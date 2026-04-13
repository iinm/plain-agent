/**
 * @import { Message, MessageContentToolUse, MessageContentToolResult, ProviderTokenUsage } from "./model"
 * @import { ExecCommandInput } from "./tools/execCommand"
 * @import { PatchFileInput } from "./tools/patchFile"
 * @import { WriteFileInput } from "./tools/writeFile"
 * @import { TmuxCommandInput } from "./tools/tmuxCommand"
 * @import { DelegateToSubagentInput } from "./tools/delegateToSubagent"
 */

import { styleText } from "node:util";
import { createPatch } from "diff";

/**
 * Format tool use for display.
 * @param {MessageContentToolUse} toolUse
 * @returns {string}
 */
export function formatToolUse(toolUse) {
  const { toolName, input } = toolUse;

  if (toolName === "exec_command") {
    /** @type {Partial<ExecCommandInput>} */
    const execCommandInput = input;
    return [
      `tool: ${toolName}`,
      `command: ${JSON.stringify(execCommandInput.command)}`,
      `args: ${JSON.stringify(execCommandInput.args)}`,
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
    const diff = patchFileInput.diff || "";

    /** @type {{search:string; replace:string}[]} */
    const diffs = [];
    const matches = Array.from(
      diff.matchAll(
        /<<<<<<< SEARCH\n(.*?)\n?=======\n(.*?)\n?>>>>>>> REPLACE/gs,
      ),
    );
    for (const match of matches) {
      const [_, search, replace] = match;
      diffs.push({ search, replace });
    }

    const highlightedDiff = diffs
      .map(
        ({ search, replace }) =>
          `${createPatch(patchFileInput.filePath || "", search, replace)
            .replace(/^-.+$/gm, (match) => styleText("red", match))
            .replace(/^\+.+$/gm, (match) => styleText("green", match))
            .replace(/^@@.+$/gm, (match) => styleText("gray", match))
            .replace(/^\\ No newline at end of file$/gm, (match) =>
              styleText("gray", match),
            )}\n-------\n${replace}`,
      )
      .join("\n\n");

    return [
      `tool: ${toolName}`,
      `path: ${patchFileInput.filePath}`,
      `diff:\n${highlightedDiff}`,
    ].join("\n");
  }

  if (toolName === "tmux_command") {
    /** @type {Partial<TmuxCommandInput>} */
    const tmuxCommandInput = input;
    return [
      `tool: ${toolName}`,
      `command: ${tmuxCommandInput.command}`,
      `args: ${JSON.stringify(tmuxCommandInput.args)}`,
    ].join("\n");
  }

  if (toolName === "delegate_to_subagent") {
    /** @type {Partial<DelegateToSubagentInput>} */
    const delegateInput = input;
    return [
      `tool: ${toolName}`,
      `name: ${delegateInput.name}`,
      `goal: ${delegateInput.goal}`,
    ].join("\n");
  }

  if (toolName === "report_as_subagent") {
    /** @type {Partial<import("./tools/reportAsSubagent").ReportAsSubagentInput>} */
    const reportAsSubagentInput = input;
    return [
      `tool: ${toolName}`,
      `memoryPath: ${reportAsSubagentInput.memoryPath}`,
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
 */
export function printMessage(message) {
  switch (message.role) {
    case "assistant": {
      // console.log(styleText("bold", "\nAgent:"));
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
            console.log(formatToolUse(part));
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
            console.log(part.text);
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
