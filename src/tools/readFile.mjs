/**
 * @import { Tool } from '../tool'
 * @import { ReadFileInput } from './readFile'
 */

import { Buffer } from "node:buffer";
import fs from "node:fs";
import readline from "node:readline";
import { noThrow } from "../utils/noThrow.mjs";

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
          description: "Maximum number of lines to return.",
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
 * until end of file, `limit` is reached, or the next line would push the
 * formatted output past `MAX_OUTPUT_BYTES` (in which case we throw with
 * a hint that tells the caller exactly how to chunk the read).
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
  // Per-line cost excluding the line-number padding, summed over
  // accepted lines. Padding is added lazily on each iteration since its
  // width depends on the largest line number we'll emit. Over-counts the
  // trailing newline (the join uses N-1, not N) which keeps us conservative.
  let acceptedNonPaddingBytes = 0;

  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo < offset) {
        continue;
      }

      const width = String(lineNo).length;
      const lineNonPadding = 1 + Buffer.byteLength(line, "utf8") + 1;
      const projected =
        acceptedNonPaddingBytes + lineNonPadding + width * (lines.length + 1);

      if (projected > MAX_OUTPUT_BYTES) {
        if (lines.length === 0) {
          throw new Error(
            `Output would exceed ${MAX_OUTPUT_BYTES} bytes at line ${lineNo}: ` +
              "that line alone is too large to include. Consider reading the file with a different tool.",
          );
        }
        const lastFitting = offset + lines.length - 1;
        throw new Error(
          `Output would exceed ${MAX_OUTPUT_BYTES} bytes at line ${lineNo}. ` +
            `Lines ${offset}-${lastFitting} fit; read them with limit=${lines.length}, ` +
            `then continue from offset=${lastFitting + 1}.`,
        );
      }

      acceptedNonPaddingBytes += lineNonPadding;
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
