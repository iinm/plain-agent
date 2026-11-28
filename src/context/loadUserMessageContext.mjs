/**
 * @import { MessageContentText, MessageContentImage } from "../model";
 */

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { styleText } from "node:util";
import {
  imageMimeTypeFromPath,
  imageMimeTypeMismatchError,
} from "../utils/imageMimeType.mjs";
import { noThrow } from "../utils/noThrow.mjs";
import { parseFileRange } from "../utils/parseFileRange.mjs";
import { readFileRange } from "../utils/readFileRange.mjs";

/**
 * @param {string} message
 * @returns {Promise<(MessageContentText | MessageContentImage)[]>}
 */
export async function loadUserMessageContext(message) {
  const workingDir = process.cwd();

  /** @type {string[]} */
  const text = [];
  /** @type {string[]} */
  const contexts = [];
  /** @type {MessageContentImage[]} */
  const images = [];

  let cursor = 0;
  for (const match of message.matchAll(
    /(^|\s)@(?:'([^']+)'|((?:\\ |[^\s])+))/g,
  )) {
    if (cursor < match.index) {
      text.push(message.slice(cursor, match.index));
    }
    cursor = match.index + match[0].length;
    const [entireMatch, leading, quoted, escaped] = match;
    const reference = quoted ?? escaped.replace(/\\ /g, " ");

    if (imageMimeTypeFromPath(reference) !== undefined) {
      const imageContent = await loadImageContent(reference);
      if (imageContent instanceof Error) {
        warn(`Failed to load image from ${reference}: ${imageContent.message}`);
        text.push(entireMatch);
        continue;
      }
      images.push(imageContent);
      text.push(`${leading}[Image #${images.length}:${reference}]`);
      continue;
    }

    const contextSnippet = await loadContextSnippet(reference, workingDir);
    if (contextSnippet) {
      contexts.push(contextSnippet);
    }
    text.push(entireMatch);
  }

  if (cursor < message.length) {
    text.push(message.slice(cursor));
  }

  return [
    { type: "text", text: [text.join(""), ...contexts].join("\n\n") },
    ...images,
  ];
}

/**
 * @param {string} reference
 * @param {string} workingDir
 * @returns {Promise<string | undefined>}
 */
async function loadContextSnippet(reference, workingDir) {
  const fileRange = parseFileRange(reference);
  if (fileRange instanceof Error) {
    warn(`Failed to parse context reference ${reference}: ${fileRange}`);
    return undefined;
  }

  const absolutePath = path.resolve(fileRange.filePath);
  if (isOutsideDirectory(workingDir, absolutePath)) {
    warn(
      `Refusing to load context from outside working directory: ${absolutePath}`,
    );
    return undefined;
  }

  const resolved = await noThrow(() =>
    Promise.all([realpath(workingDir), realpath(fileRange.filePath)]),
  );
  if (resolved instanceof Error) {
    warn(`Failed to load context from ${reference}: ${resolved.message}`);
    return undefined;
  }

  const [resolvedWorkingDir, resolvedFilePath] = resolved;
  if (isOutsideDirectory(resolvedWorkingDir, resolvedFilePath)) {
    warn(
      `Refusing to load context from outside working directory: ${resolvedFilePath}`,
    );
    return undefined;
  }

  const fileContent = await readFileRange({
    ...fileRange,
    filePath: resolvedFilePath,
  });
  if (fileContent instanceof Error) {
    warn(`Failed to load context from ${reference}: ${fileContent}`);
    return undefined;
  }

  return [`<context location="${reference}">`, fileContent, "</context>"].join(
    "\n",
  );
}

/** @param {string} directory @param {string} target */
function isOutsideDirectory(directory, target) {
  const relative = path.relative(directory, target);
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

/**
 * @param {string} imagePath
 * @returns {Promise<MessageContentImage | Error>}
 */
async function loadImageContent(imagePath) {
  const absolutePath = path.resolve(imagePath);

  return await noThrow(async () => {
    const data = await readFile(absolutePath);
    const mimeType = mimeTypeOrError(absolutePath);
    const mismatchError = imageMimeTypeMismatchError(
      absolutePath,
      mimeType,
      data,
    );
    if (mismatchError) {
      throw mismatchError;
    }
    return {
      type: "image",
      data: data.toString("base64"),
      mimeType,
    };
  });
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function mimeTypeOrError(filePath) {
  const mimeType = imageMimeTypeFromPath(filePath);
  if (mimeType === undefined) {
    throw new Error(
      `Unsupported image extension: ${path.extname(filePath).toLowerCase()} (file: ${filePath})`,
    );
  }

  return mimeType;
}

/**
 * @param {string} message
 * @returns {void}
 */
function warn(message) {
  console.error(styleText("yellow", message));
}
