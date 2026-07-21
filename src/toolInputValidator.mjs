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

const BUILTIN_ALLOWED_PATHS = [
  AGENT_MEMORY_DIR,
  AGENT_TMP_DIR,
  CLAUDE_CODE_PLUGIN_DIR,
];

/**
 * @param {unknown} input
 * @param {string[]} [allowedPaths=[]] - Additional allowed paths (outside working directory)
 * @param {boolean} [allowGitUnmanagedFiles=false] - Allow access to git-unmanaged files
 * @param {boolean} [allowOutsideWorkingDirectory=false] - Allow paths outside the working directory
 * @returns {boolean}
 */
export function isSafeToolInput(
  input,
  allowedPaths = [],
  allowGitUnmanagedFiles = false,
  allowOutsideWorkingDirectory = false,
) {
  if (["number", "boolean", "undefined"].includes(typeof input)) {
    return true;
  }

  if (typeof input === "string") {
    return isSafeToolInputItem(
      input,
      allowedPaths,
      allowGitUnmanagedFiles,
      allowOutsideWorkingDirectory,
    );
  }

  if (Array.isArray(input)) {
    return input.every((item) =>
      isSafeToolInput(
        item,
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      ),
    );
  }

  if (typeof input === "object") {
    if (input === null) {
      return true;
    }
    return Object.values(input).every((value) =>
      isSafeToolInput(
        value,
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      ),
    );
  }

  return false;
}

/**
 * @param {string} arg
 * @param {string[]} [allowedPaths=[]] - Additional allowed paths (outside working directory)
 * @param {boolean} [allowGitUnmanagedFiles=false] - Allow access to git-unmanaged files
 * @param {boolean} [allowOutsideWorkingDirectory=false] - Allow paths outside the working directory
 * @returns {boolean}
 */
export function isSafeToolInputItem(
  arg,
  allowedPaths = [],
  allowGitUnmanagedFiles = false,
  allowOutsideWorkingDirectory = false,
) {
  // @<path> pattern (e.g., curl -d @file.json)
  if (arg.startsWith("@")) {
    const pathPart = arg.slice(1);
    return (
      isSafeToolInputItemRaw(
        arg,
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      ) &&
      isSafeToolInputItemRaw(
        pathPart,
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      )
    );
  }

  // --opt=val pattern (e.g., npm --prefix=foo)
  const longOptMatch = arg.match(/^--[^=]+=(.+)$/);
  if (longOptMatch) {
    return (
      isSafeToolInputItemRaw(
        arg,
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      ) &&
      isSafeToolInputItem(
        longOptMatch[1],
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      )
    );
  }

  // -X<val> pattern (e.g., gcc -oout, gcc -I/usr/include)
  const shortOptMatch = arg.match(/^-[a-zA-Z](.+)$/);
  if (shortOptMatch) {
    return (
      isSafeToolInputItemRaw(
        arg,
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      ) &&
      isSafeToolInputItem(
        shortOptMatch[1],
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      )
    );
  }

  // VAR=val pattern (e.g., make OUTPUT=/path, env KEY=val)
  // Must not start with - or @ (already handled above)
  const keyValueMatch = arg.match(/^[^-@][^=]*=(.+)$/);
  if (keyValueMatch) {
    return (
      isSafeToolInputItemRaw(
        arg,
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      ) &&
      isSafeToolInputItem(
        keyValueMatch[1],
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      )
    );
  }

  // file:// pattern — references the local filesystem
  const fileMatch = arg.match(/^file:\/\/(.+)$/i);
  if (fileMatch) {
    return (
      isSafeToolInputItemRaw(
        arg,
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      ) &&
      isSafeToolInputItemRaw(
        `/${fileMatch[1]}`,
        allowedPaths,
        allowGitUnmanagedFiles,
        allowOutsideWorkingDirectory,
      )
    );
  }
  return isSafeToolInputItemRaw(
    arg,
    allowedPaths,
    allowGitUnmanagedFiles,
    allowOutsideWorkingDirectory,
  );
}

/**
 * @param {string} arg
 * @param {string[]} [allowedPaths=[]] - Additional allowed paths (outside working directory)
 * @param {boolean} [allowGitUnmanagedFiles=false] - Allow access to git-unmanaged files
 * @param {boolean} [allowOutsideWorkingDirectory=false] - Allow paths outside the working directory
 * @returns {boolean}
 */
function isSafeToolInputItemRaw(
  arg,
  allowedPaths = [],
  allowGitUnmanagedFiles = false,
  allowOutsideWorkingDirectory = false,
) {
  const workingDir = process.cwd();

  // Note: An argument can be a command option (e.g., '-l').
  // It will then create an absolute path like `/path/to/project/-l`.
  const absPath = path.resolve(arg);

  const realPath = resolveRealPath(absPath, workingDir);
  if (!realPath) {
    return false;
  }

  // Disallow any input that contains ".." as a path segment (directory traversal)
  // Example:
  // - When write_file is allowed for ^safe-dir/.+
  // - "safe-dir/../unsafe-path" should be disallowed
  // This check must happen before allowedPaths check for security
  if (arg.split(path.sep).includes("..")) {
    return false;
  }

  // Built-in allowed paths (memory, tmp, claude-code-plugins) are always safe.
  // This check must come before the .plain-agent/ block below.
  if (isInBuiltinAllowedPath(realPath)) {
    return true;
  }

  // Any other path under .plain-agent/ is unsafe and cannot be overridden
  // by allowedPaths. This prevents privilege escalation via sandbox scripts
  // or config files even when explicitly listed in allowedPaths.
  if (isInsideProjectMetadataDir(realPath)) {
    return false;
  }

  // Path must be inside the working directory or in user-configured allowed paths
  // (unless path validation is relaxed to allow any path outside the working directory)
  if (
    !allowOutsideWorkingDirectory &&
    !isInsideWorkingDirectory(realPath, workingDir) &&
    !isInUserAllowedPath(realPath, allowedPaths)
  ) {
    return false;
  }

  // Deny git-unmanaged files (outside git repo or git-ignored)
  if (!allowGitUnmanagedFiles && !isGitManaged(realPath)) {
    return false;
  }

  return true;
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
 * Check if the path is under a built-in allowed directory
 * (.plain-agent/{memory,tmp,claude-code-plugins}).
 * @param {string} targetPath - Must be an absolute path.
 * @returns {boolean}
 */
function isInBuiltinAllowedPath(targetPath) {
  for (const builtinPath of BUILTIN_ALLOWED_PATHS) {
    const absPath = path.resolve(builtinPath);
    if (
      targetPath === absPath ||
      targetPath.startsWith(`${absPath}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the path is under a user-configured allowed path.
 * @param {string} targetPath - Must be an absolute path.
 * @param {string[]} allowedPaths - Additional absolute paths (outside working directory)
 * @returns {boolean}
 */
function isInUserAllowedPath(targetPath, allowedPaths) {
  // User-provided paths must be absolute; relative paths are silently skipped
  // to prevent unintended access from CWD-dependent resolution.
  for (const allowedPath of allowedPaths) {
    if (!path.isAbsolute(allowedPath)) {
      continue;
    }
    if (
      targetPath === allowedPath ||
      targetPath.startsWith(`${allowedPath}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the path is under .plain-agent/.
 * @param {string} targetPath
 * @returns {boolean}
 */
function isInsideProjectMetadataDir(targetPath) {
  const metadataAbsPath = path.resolve(AGENT_PROJECT_METADATA_DIR);
  return (
    targetPath === metadataAbsPath ||
    targetPath.startsWith(`${metadataAbsPath}${path.sep}`)
  );
}

/**
 * Check if the path is managed by git (inside a git repo and not ignored).
 * @param {string} absPath
 * @returns {boolean}
 */
function isGitManaged(absPath) {
  const dir = findExistingDirectory(absPath);

  /** @type {string} */
  let gitRoot;
  try {
    gitRoot = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
  } catch {
    // Not inside a git repository
    return false;
  }

  try {
    execFileSync(
      "git",
      ["-C", gitRoot, "check-ignore", "--no-index", "-q", absPath],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    // File is git-ignored: not managed
    return false;
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      typeof error.status === "number" &&
      error.status === 1
    ) {
      // Not ignored: managed
      return true;
    }
    // Other error: treat as not managed for safety
    return false;
  }
}

/**
 * @param {string} absPath
 * @returns {string}
 */
function findExistingDirectory(absPath) {
  const stats = noThrowSync(() => fs.statSync(absPath));
  if (!(stats instanceof Error)) {
    return stats.isDirectory() ? absPath : path.dirname(absPath);
  }
  let dir = absPath;
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}
