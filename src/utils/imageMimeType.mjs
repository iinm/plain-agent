import path from "node:path";

/**
 * Returns the MIME type declared by the file extension.
 * Returns `undefined` when the extension is not a supported image format.
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function imageMimeTypeFromPath(filePath) {
  return IMAGE_MIME_TYPES.get(path.extname(filePath).toLowerCase());
}

/**
 * Returns the MIME type detected from the file's magic bytes.
 * Returns `undefined` when the data does not start with a supported image signature.
 * @param {Uint8Array} data
 * @returns {string | undefined}
 */
export function imageMimeTypeFromBytes(data) {
  if (startsWith(data, PNG_SIGNATURE)) {
    return "image/png";
  }
  if (startsWith(data, JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  if (startsWith(data, GIF_SIGNATURE)) {
    return "image/gif";
  }
  if (
    startsWith(data, RIFF_SIGNATURE) &&
    startsWith(data.subarray(8), WEBP_SIGNATURE)
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Returns an Error when `data` does not match the MIME type declared by the
 * extension. The declared type is never replaced by the detected one; callers
 * decide how to handle the mismatch.
 * @param {string} filePath
 * @param {string} declaredMimeType
 * @param {Uint8Array} data
 * @returns {Error | undefined}
 */
export function imageMimeTypeMismatchError(filePath, declaredMimeType, data) {
  const detectedMimeType = imageMimeTypeFromBytes(data);
  if (detectedMimeType === declaredMimeType) {
    return undefined;
  }

  const contentDescription =
    detectedMimeType === undefined
      ? "the content is not PNG, JPEG, GIF, or WebP"
      : `the content is ${detectedMimeType}`;
  return new Error(
    `${filePath} declares ${declaredMimeType} by its extension, but ${contentDescription}. The extension and content must agree; fix the file or its extension.`,
  );
}

/** @type {ReadonlyMap<string, string>} */
const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/** @type {number[]} */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** @type {number[]} */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

/** @type {number[]} */
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38];

/** @type {number[]} */
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];

/** @type {number[]} */
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50];

/**
 * @param {Uint8Array} data
 * @param {number[]} signature
 * @returns {boolean}
 */
function startsWith(data, signature) {
  if (data.length < signature.length) {
    return false;
  }
  return signature.every((byte, index) => data[index] === byte);
}
