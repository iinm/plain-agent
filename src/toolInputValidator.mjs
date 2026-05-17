import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_MEMORY_DIR,
  AGENT_PROJECT_METADATA_DIR,
  AGENT_TMP_DIR,
  CLAUDE_CODE_PLUGIN_DIR,
} from "./env.mjs";
import { noThrowSync } from "./utils/noThrow.mjs";

// Paths that must never be auto-approvable as tool input, even when
// git-managed. Sandbox scripts run on the host and the project config files
// drive auto-approval policy itself, so silent in-sandbox modification of
// either could lead to host code execution or self-granted privilege
// escalation.
const UNSAFE_PROJECT_PATHS = [
  path.join(AGENT_PROJECT_METADATA_DIR, "sandbox"),
  path.join(AGENT_PROJECT_METADATA_DIR, "config.json"),
  path.join(AGENT_PROJECT_METADATA_DIR, "config.local.json"),
];

/** Built-in allowed paths that are always safe */
const BUILTIN_ALLOWED_PATHS = [
  AGENT_MEMORY_DIR,
  AGENT_TMP_DIR,
  CLAUDE_CODE_PLUGIN_DIR,
];

/**
 * @param {unknown} input
 * @param {string[]} [allowedPaths=[]] - Additional allowed paths (merged from config)
 * @returns {boolean}
 */
export function isSafeToolInput(input, allowedPaths = []) {
  if (["number", "boolean", "undefined"].includes(typeof input)) {
    return true;
  }

  if (typeof input === "string") {
    return isSafeToolInputItem(input, allowedPaths);
  }

  if (Array.isArray(input)) {
    return input.every((item) => isSafeToolInput(item, allowedPaths));
  }

  if (typeof input === "object") {
    if (input === null) {
      return true;
    }
    return Object.values(input).every((value) =>
      isSafeToolInput(value, allowedPaths),
    );
  }

  return false;
}

/**
 * @param {string} arg
 * @param {string[]} [allowedPaths=[]] - Additional allowed paths (merged from config)
 * @returns {boolean}
 */
export function isSafeToolInputItem(arg, allowedPaths = []) {
  const workingDir = process.cwd();

  // Note: An argument can be a command option (e.g., '-l').
  // It will then create an absolute path like `/path/to/project/-l`.
  const absPath = path.resolve(arg);

  const realPath = resolveRealPath(absPath, workingDir);
  if (!realPath) {
    return false;
  }

  // Disallow paths outside the working directory first
  // (but we'll check allowedPaths after the .. check)
  const isOutsideWorkingDir = !isInsideWorkingDirectory(realPath, workingDir);

  // Disallow any input that contains ".." as a path segment (directory traversal)
  // Example:
  // - When write_file is allowed for ^safe-dir/.+
  // - "safe-dir/../unsafe-path" should be disallowed
  // This check must happen before allowedPaths check for security
  if (arg.split(path.sep).includes("..")) {
    return false;
  }

  // Always require approval for these, even if git-managed.
  if (isUnsafeProjectPath(realPath)) {
    return false;
  }

  // Check if the path is in allowed paths (built-in + configured)
  // This allows access to directories outside the working directory
  if (isInAllowedPath(realPath, allowedPaths)) {
    return true;
  }

  // Disallow paths outside the working directory (not in allowedPaths)
  if (isOutsideWorkingDir) {
    return false;
  }

  // Deny git ignored files (which may contain sensitive information or should not be accessed)
  return !isGitIgnored(realPath);
}

/**
 * @param {string} absPath
 * @param {string} workingDir
 * @returns {string | null}
 */
function resolveRealPath(absPath, workingDir) {
  const realPathResult = noThrowSync(() => fs.realpathSync(absPath));
  if (!(realPathResult instanceof Error)) {
    return realPathResult;
  }

  // realpathSync can fail if the path (or its target) doesn't exist.
  // Manually follow symlink chain for broken links to ensure they don't point outside.
  let currentPath = absPath;
  const seen = new Set();
  const MAX_SYMLINK_DEPTH = 10;

  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
    if (seen.has(currentPath)) {
      return null; // Circular link
    }
    seen.add(currentPath);

    // Check if the current path is a symbolic link.
    const lstats = noThrowSync(() => fs.lstatSync(currentPath));
    if (lstats instanceof Error || !lstats.isSymbolicLink()) {
      break; // Not a symlink or doesn't exist; stop traversal.
    }

    // Read the target path the symlink points to.
    const target = noThrowSync(() => fs.readlinkSync(currentPath));
    if (typeof target !== "string") {
      break; // Failed to read the link; stop traversal.
    }

    currentPath = path.resolve(path.dirname(currentPath), target);

    // If at any point it goes outside, we stop and use this path for the check.
    if (!isInsideWorkingDirectory(currentPath, workingDir)) {
      return currentPath;
    }
  }

  if (seen.size >= MAX_SYMLINK_DEPTH) {
    return null; // Too deep
  }

  return currentPath;
}

/**
 * @param {string} targetPath
 * @param {string} workingDir
 * @returns {boolean}
 */
function isInsideWorkingDirectory(targetPath, workingDir) {
  return (
    targetPath === workingDir ||
    targetPath.startsWith(`${workingDir}${path.sep}`)
  );
}

/**
 * Check if the path is in allowed paths (built-in + configured).
 * @param {string} targetPath
 * @param {string[]} allowedPaths - Additional allowed paths from config
 * @returns {boolean}
 */
function isInAllowedPath(targetPath, allowedPaths) {
  const allAllowedPaths = [...BUILTIN_ALLOWED_PATHS, ...allowedPaths];

  for (const allowedPath of allAllowedPaths) {
    const allowedAbsPath = path.resolve(allowedPath);
    if (
      targetPath === allowedAbsPath ||
      targetPath.startsWith(`${allowedAbsPath}${path.sep}`)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string} targetPath
 * @returns {boolean}
 */
function isUnsafeProjectPath(targetPath) {
  for (const unsafePath of UNSAFE_PROJECT_PATHS) {
    const unsafeAbsPath = path.resolve(unsafePath);
    if (
      targetPath === unsafeAbsPath ||
      targetPath.startsWith(`${unsafeAbsPath}${path.sep}`)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string} absPath
 * @returns {boolean}
 */
function isGitIgnored(absPath) {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", absPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    // The path is ignored (exit code 0)
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      typeof error.status === "number" &&
      error.status === 1
    ) {
      // Path is not ignored
      return false;
    }
    // Other errors (e.g., status 128 if not a git repo or other git error)
    // We treat this as "effectively ignored" to be safe.
    return true;
  }
}
