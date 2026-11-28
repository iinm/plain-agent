/**
 * @import { StructuredToolResultContent, Tool } from '../tool'
 * @import { ReadImageInput } from './readImage'
 */

import {
  createFileAccess,
  FILE_TARGET,
  FileSizeLimitError,
} from "../fileAccess.mjs";
import { formatBytes } from "../utils/formatBytes.mjs";
import {
  imageMimeTypeFromPath,
  imageMimeTypeMismatchError,
} from "../utils/imageMimeType.mjs";
import { noThrow } from "../utils/noThrow.mjs";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * @param {import("../fileAccess.mjs").FileAccess} [files]
 * @returns {Tool}
 */
export function createReadImageTool(files = createFileAccess()) {
  return {
    fileTarget: FILE_TARGET,
    def: {
      name: "read_image",
      description:
        "Read an image file (png, jpg, jpeg, gif, webp) and return the image itself so you can see it.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
          },
        },
        required: ["filePath"],
      },
    },

    /**
     * @param {ReadImageInput} input
     * @param {import("../fileAccess.mjs").FileTarget} [target]
     * @returns {Promise<StructuredToolResultContent[] | Error>}
     */
    impl: async (input, target) =>
      await noThrow(async () => {
        const { filePath } = input;
        const mimeType = imageMimeTypeFromPath(filePath);
        if (mimeType === undefined) {
          throw new Error(
            `Unsupported image file: ${filePath}. Supported extensions are .png, .jpg, .jpeg, .gif, and .webp.`,
          );
        }

        const data = await files
          .readFile(target?.realPath ?? filePath, MAX_IMAGE_BYTES)
          .catch((error) => {
            if (error instanceof FileSizeLimitError) {
              throw new Error(
                `Image is ${formatBytes(error.bytesRead)}, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit (${filePath}). Resize it first (e.g. with exec_command) and retry.`,
              );
            }
            throw error;
          });
        const mismatchError = imageMimeTypeMismatchError(
          filePath,
          mimeType,
          data,
        );
        if (mismatchError) {
          throw mismatchError;
        }

        /** @type {StructuredToolResultContent[]} */
        const content = [
          { type: "image", data: data.toString("base64"), mimeType },
        ];
        return content;
      }),
  };
}

export const readImageTool = createReadImageTool();
