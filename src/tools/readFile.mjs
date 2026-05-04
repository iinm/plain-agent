/**
 * @import { Tool } from '../tool'
 * @import { ReadFileInput } from './readFile'
 */

import fs from "node:fs";
import readline from "node:readline";
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

      const lines = await readLineRange(filePath, offset, limit);
      return formatNumberedLines(lines, offset);
    }),
};

/**
 * Stream the file line-by-line, skip until `offset`, collect up to `limit`
 * lines, then close the stream. Avoids loading large files into memory.
 *
 * @param {string} filePath
 * @param {number} offset
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
async function readLineRange(filePath, offset, limit) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  /** @type {string[]} */
  const lines = [];
  let lineNo = 0;

  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo < offset) {
        continue;
      }
      lines.push(line);
      if (lines.length >= limit) {
        break;
      }
    }
  } finally {
    rl.close();
    if (!stream.destroyed) {
      stream.destroy();
    }
  }

  return lines;
}

/**
 * Format an array of lines as `cat -n` style output. The padding width is
 * based on the largest emitted line number in this call; widths may differ
 * across calls but the column stays aligned within a single response.
 *
 * @param {string[]} lines
 * @param {number} startLine 1-indexed line number of `lines[0]`.
 * @returns {string}
 */
function formatNumberedLines(lines, startLine) {
  if (lines.length === 0) {
    return "";
  }
  const lastLineNo = startLine + lines.length - 1;
  const width = String(lastLineNo).length;

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = String(startLine + i).padStart(width, " ");
    out.push(`${lineNo}\t${lines[i]}`);
  }
  return out.join("\n");
}
