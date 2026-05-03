/**
 * @import { Tool } from '../tool'
 * @import { ReadFileInput } from './readFile'
 */

import fs from "node:fs/promises";
import { noThrow } from "../utils/noThrow.mjs";

const DEFAULT_LIMIT = 200;

/** @type {Tool} */
export const readFileTool = {
  def: {
    name: "read_file",
    description:
      "Read a file with line numbers (1-indexed). Output format mirrors `cat -n` (right-aligned line number, tab, line content).",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
        },
        offset: {
          description: "1-indexed start line. Defaults to 1.",
          type: "number",
        },
        limit: {
          description: `Maximum number of lines to return. Defaults to ${DEFAULT_LIMIT}.`,
          type: "number",
        },
      },
      required: ["filePath"],
    },
  },

  /**
   * @param {ReadFileInput} input
   * @returns {Promise<string | Error>}
   */
  impl: async (input) =>
    await noThrow(async () => {
      const { filePath } = input;
      const offset = input.offset ?? 1;
      const limit = input.limit ?? DEFAULT_LIMIT;

      if (!Number.isInteger(offset) || offset < 1) {
        throw new Error("offset must be a positive integer (1-indexed)");
      }
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("limit must be a positive integer");
      }

      const content = await fs.readFile(filePath, "utf8");
      return formatNumberedLines(content, offset, limit);
    }),
};

/**
 * @param {string} content
 * @param {number} offset
 * @param {number} limit
 * @returns {string}
 */
function formatNumberedLines(content, offset, limit) {
  // Split on \n; the trailing empty element after a terminating newline is
  // dropped to mirror `cat -n` behavior (no spurious blank last line).
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const totalLines = lines.length;
  if (offset > totalLines) {
    return "";
  }

  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, totalLines);
  // Width is based on the file's total line count so the column stays
  // stable across calls with different offset/limit.
  const width = String(totalLines).length;

  const out = [];
  for (let i = startIdx; i < endIdx; i++) {
    const lineNo = String(i + 1).padStart(width, " ");
    out.push(`${lineNo}\t${lines[i]}`);
  }
  return out.join("\n");
}
