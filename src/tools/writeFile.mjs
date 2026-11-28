/**
 * @import { Tool } from '../tool'
 * @import { WriteFileInput } from './writeFile'
 */

import { createFileAccess, FILE_TARGET } from "../fileAccess.mjs";
import { noThrow } from "../utils/noThrow.mjs";

/**
 * @param {import("../fileAccess.mjs").FileAccess} [files]
 * @returns {Tool}
 */
export function createWriteFileTool(files = createFileAccess()) {
  return {
    fileTarget: FILE_TARGET,
    def: {
      name: "write_file",
      description: "Write a file",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
          },
          content: {
            type: "string",
          },
        },
        required: ["filePath", "content"],
      },
    },

    validateInput: validateWriteInput,

    /**
     * @param {WriteFileInput} input
     * @param {import("../fileAccess.mjs").FileTarget} [target]
     * @returns {Promise<string | Error>}
     */
    impl: async (input, target) =>
      await noThrow(async () => {
        const invalidInput = validateWriteInput(input);
        if (invalidInput) return invalidInput;

        const { filePath, content } = input;

        await files.writeFile(target?.realPath ?? filePath, content, {
          createParents: true,
        });
        return `Wrote to file: ${filePath}`;
      }),

    /**
     * @param {Record<string, unknown>} input
     * @returns {Record<string, unknown>}
     */
    maskApprovalInput: (input) => {
      const writeFileInput = /** @type {WriteFileInput} */ (input);
      return {
        filePath: writeFileInput.filePath,
      };
    },
  };
}

export const writeFileTool = createWriteFileTool();

/** @param {Record<string, unknown>} input */
function validateWriteInput(input) {
  if (!input || typeof input !== "object") {
    return new Error("write_file input must be an object");
  }

  const { filePath, content } = input;
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath.includes("\0")
  ) {
    return new Error("filePath must be a non-empty path without null bytes");
  }
  if (typeof content !== "string") {
    return new Error("content must be a string");
  }
  return undefined;
}
