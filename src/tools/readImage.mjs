/**
 * @import { StructuredToolResultContent, Tool } from '../tool'
 * @import { ReadImageInput } from './readImage'
 */

import fs from "node:fs/promises";
import { formatBytes } from "../utils/formatBytes.mjs";
import {
  imageMimeTypeFromPath,
  imageMimeTypeMismatchError,
} from "../utils/imageMimeType.mjs";
import { noThrow } from "../utils/noThrow.mjs";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** @type {Tool} */
export const readImageTool = {
  def: {
    name: "read_image",
    description:
      "Read an image file (png, jpg, jpeg, gif, webp) and return the image itself so you can see it. Use this instead of read_file for images. The content must match the extension; mismatched files are rejected. Images larger than 2 MB are rejected; resize them first.",
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
   * @returns {Promise<StructuredToolResultContent[] | Error>}
   */
  impl: async (input) =>
    await noThrow(async () => {
      const { filePath } = input;
      const mimeType = imageMimeTypeFromPath(filePath);
      if (mimeType === undefined) {
        throw new Error(
          `Unsupported image file: ${filePath}. Supported extensions are .png, .jpg, .jpeg, .gif, and .webp.`,
        );
      }

      const { size } = await fs.stat(filePath);
      if (size > MAX_IMAGE_BYTES) {
        throw new Error(
          `Image is ${formatBytes(size)}, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit (${filePath}). Resize it first (e.g. with exec_command) and retry.`,
        );
      }

      const data = await fs.readFile(filePath);
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
