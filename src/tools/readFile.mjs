/**
 * @import { Tool } from '../tool'
 * @import { ReadFileInput } from './readFile'
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import readline from "node:readline";
import { noThrow } from "../utils/noThrow.mjs";

// Cap output at the same size exec_command uses so a single tool call
// can't blow past the model's context budget. Going over this throws an
// error rather than silently truncating, since a partial read would let
// the LLM mistake a clipped file for the complete one.
const MAX_OUTPUT_BYTES = 1024 * 8;

/** @type {Tool} */
export const readFileTool = {
  def: {
    name: "read_file",
    description: `Read a file with line numbers (1-indexed). Output format mirrors \`cat -n\` (right-aligned line number, tab, line content). Errors if the resulting output would exceed ${MAX_OUTPUT_BYTES} bytes; pass \`offset\` and \`limit\` to read large files in chunks.`,
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
          description: "Maximum number of lines to return. Optional.",
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
      const limit = input.limit;

      if (!Number.isInteger(offset) || offset < 1) {
        throw new Error("offset must be a positive integer (1-indexed)");
      }
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error("limit must be a positive integer");
      }

      const lines = await readLineRange(filePath, offset, limit);
      return formatNumberedLines(lines, offset);
    }),
};

/**
 * Stream the file line-by-line, skip until `offset`, and collect lines
 * until any of the following stops the read:
 *   1. End of file.
 *   2. `limit` lines collected (when provided by the caller).
 *   3. The next line would push the formatted output past
 *      `MAX_OUTPUT_BYTES`, in which case we throw with a hint that tells
 *      the caller exactly how to chunk the read.
 *
 * @param {string} filePath
 * @param {number} offset
 * @param {number | undefined} limit
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
  // Running estimate of the formatted output bytes for the lines we've
  // already accepted. Slightly over-counts the trailing newline (the
  // final join uses N-1 newlines, not N) which keeps us conservative.
  let totalBytes = 0;
  let currentWidth = 0;
  let exceededAtLine = -1;

  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo < offset) {
        continue;
      }

      // The padding width grows as line numbers cross 9->10, 99->100,
      // etc. When that happens, every line we already accepted needs an
      // extra padding byte to stay column-aligned.
      const newWidth = String(lineNo).length;
      if (newWidth > currentWidth && lines.length > 0) {
        totalBytes += (newWidth - currentWidth) * lines.length;
      }
      currentWidth = newWidth;

      // Per-line cost: width + tab + content + newline (used by the join).
      const lineCost = currentWidth + 1 + Buffer.byteLength(line, "utf8") + 1;

      if (totalBytes + lineCost > MAX_OUTPUT_BYTES) {
        exceededAtLine = lineNo;
        break;
      }

      totalBytes += lineCost;
      lines.push(line);

      if (limit !== undefined && lines.length >= limit) {
        break;
      }
    }
  } finally {
    rl.close();
    if (!stream.destroyed) {
      stream.destroy();
    }
  }

  if (exceededAtLine !== -1) {
    if (lines.length === 0) {
      throw new Error(
        `Output would exceed ${MAX_OUTPUT_BYTES} bytes at line ${exceededAtLine}: ` +
          "that line alone is too large to include. Consider reading the file with a different tool.",
      );
    }
    const lastFitting = offset + lines.length - 1;
    throw new Error(
      `Output would exceed ${MAX_OUTPUT_BYTES} bytes at line ${exceededAtLine}. ` +
        `Lines ${offset}-${lastFitting} fit; read them with limit=${lines.length}, ` +
        `then continue from offset=${lastFitting + 1}.`,
    );
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
