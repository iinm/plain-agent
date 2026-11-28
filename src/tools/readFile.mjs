/**
 * @import { Tool } from '../tool'
 * @import { ReadFileInput } from './readFile'
 */

import readline from "node:readline";
import { createFileAccess, FILE_TARGET } from "../fileAccess.mjs";
import { imageMimeTypeFromPath } from "../utils/imageMimeType.mjs";
import { lineHash } from "../utils/lineHash.mjs";
import { noThrow } from "../utils/noThrow.mjs";

const OUTPUT_MAX_LENGTH = 1024 * 8;

/**
 * @param {import("../fileAccess.mjs").FileAccess} [files]
 * @returns {Tool}
 */
export function createReadFileTool(files = createFileAccess()) {
  return {
    fileTarget: FILE_TARGET,
    def: {
      name: "read_file",
      description:
        "Read a file with line numbers (1-indexed). Each line is prefixed with its number and a short content hash: `{no}:{hash}|{content}` (e.g. `1:a3|function hello() {`).",
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
     * @param {import("../fileAccess.mjs").FileTarget} [target]
     * @returns {Promise<string | Error>}
     */
    impl: async (input, target) =>
      await noThrow(async () => {
        const { filePath } = input;
        const offset = input.offset ?? 1;
        const limit = input.limit;

        const mimeType = imageMimeTypeFromPath(filePath);
        if (mimeType !== undefined) {
          throw new Error(
            `${filePath} is an image (${mimeType}). Use read_image to see it.`,
          );
        }

        if (!Number.isInteger(offset) || offset < 1) {
          throw new Error("offset must be a positive integer (1-indexed)");
        }
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw new Error("limit must be a positive integer");
        }

        const lines = await files.readStream(
          target?.realPath ?? filePath,
          (stream) => readLineRange(stream, offset, limit),
        );
        return formatNumberedLines(lines, offset);
      }),
  };
}

export const readFileTool = createReadFileTool();

/**
 * @param {import("node:stream").Readable} stream
 * @param {number} offset
 * @param {number | undefined} limit
 * @returns {Promise<string[]>}
 */
async function readLineRange(stream, offset, limit) {
  stream.setEncoding("utf8");
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  /** @type {string[]} */
  const lines = [];
  let lineNo = 0;
  // Line-number padding and tab separator are not counted toward the cap.
  let acceptedLength = 0;

  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo < offset) {
        continue;
      }

      const lineCost = line.length + 1;

      if (acceptedLength + lineCost > OUTPUT_MAX_LENGTH) {
        if (lines.length === 0) {
          throw new Error(
            `Output would exceed ${OUTPUT_MAX_LENGTH} characters at line ${lineNo}: ` +
              "that line alone is too large to include. Consider reading the file with a different tool.",
          );
        }
        const lastFitting = offset + lines.length - 1;
        throw new Error(
          `Output would exceed ${OUTPUT_MAX_LENGTH} characters at line ${lineNo}. ` +
            `Lines ${offset}-${lastFitting} fit; read them with limit=${lines.length}, ` +
            `then continue from offset=${lastFitting + 1}.`,
        );
      }

      acceptedLength += lineCost;
      lines.push(line);

      if (limit !== undefined && lines.length >= limit) {
        break;
      }
    }
  } finally {
    rl.close();
  }

  return lines;
}

/**
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
    const hash = lineHash(lines[i]);
    out.push(`${lineNo}:${hash}|${lines[i]}`);
  }
  return out.join("\n");
}
