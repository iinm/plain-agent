/** @import { ApprovalPath } from "./tool" */

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

/** @typedef {{ reason: string, path?: ApprovalPath }} UnsafeToolInput */

/**
 * Check tool input for unsafe file access. String values are treated as file
 * paths and validated: working directory / allowedPaths confinement, no ".."
 * traversal, no .git/ or .plain-agent/ metadata access, git-managed files only.
 * Compound arguments (@file, --opt=val, -Xval, VAR=val, file://) are
 * decomposed before validation.
 *
 * @param {unknown} input
 * @param {string[]} [allowedPaths=[]] - Additional allowed paths (outside working directory)
 * @param {boolean} [allowGitUnmanagedFiles=false] - Allow access to git-unmanaged files
 * @returns {UnsafeToolInput | undefined} Failure details, or undefined when the input is safe
 */
export function findUnsafeToolInput(
  input,
  allowedPaths = [],
  allowGitUnmanagedFiles = false,
) {
  if (["number", "boolean", "undefined"].includes(typeof input)) {
    return undefined;
  }

  if (typeof input === "string") {
    return findUnsafeItem(input, allowedPaths, allowGitUnmanagedFiles);
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const failure = findUnsafeToolInput(
        item,
        allowedPaths,
        allowGitUnmanagedFiles,
      );
      if (failure !== undefined) {
        return failure;
      }
    }
    return undefined;
  }

  if (typeof input === "object") {
    if (input === null) {
      return undefined;
    }
    for (const value of Object.values(input)) {
      const failure = findUnsafeToolInput(
        value,
        allowedPaths,
        allowGitUnmanagedFiles,
      );
      if (failure !== undefined) {
        return failure;
      }
    }
    return undefined;
  }

  return { reason: `unsupported input type: ${typeof input}` };
}

/**
 * @param {string} arg
 * @param {string[]} [allowedPaths=[]] - Additional allowed paths (outside working directory)
 * @param {boolean} [allowGitUnmanagedFiles=false] - Allow access to git-unmanaged files
 * @returns {UnsafeToolInput | undefined}
 */
function findUnsafeItem(
  arg,
  allowedPaths = [],
  allowGitUnmanagedFiles = false,
) {
  // @<path> pattern (e.g., curl -d @file.json)
  if (arg.startsWith("@")) {
    const pathPart = arg.slice(1);
    return (
      findUnsafeRawItem(arg, allowedPaths, allowGitUnmanagedFiles) ??
      findUnsafeRawItem(pathPart, allowedPaths, allowGitUnmanagedFiles)
    );
  }

  // --opt=val pattern (e.g., npm --prefix=foo)
  const longOptMatch = arg.match(/^--[^=]+=(.+)$/);
  if (longOptMatch) {
    return (
      findUnsafeRawItem(arg, allowedPaths, allowGitUnmanagedFiles) ??
      findUnsafeItem(longOptMatch[1], allowedPaths, allowGitUnmanagedFiles)
    );
  }

  // -X<val> pattern (e.g., gcc -oout, gcc -I/usr/include)
  const shortOptMatch = arg.match(/^-[a-zA-Z](.+)$/);
  if (shortOptMatch) {
    return (
      findUnsafeRawItem(arg, allowedPaths, allowGitUnmanagedFiles) ??
      findUnsafeItem(shortOptMatch[1], allowedPaths, allowGitUnmanagedFiles)
    );
  }

  // VAR=val pattern (e.g., make OUTPUT=/path, env KEY=val)
  // Must not start with - or @ (already handled above)
  // Key must not contain whitespace; otherwise a whole `bash -c` script string
  // (e.g. `cd … && HOME=/tmp npm …`) would be misdetected as VAR=val.
  const keyValueMatch = arg.match(/^[^-@][^=\s]*=(.+)$/);
  if (keyValueMatch) {
    return (
      findUnsafeRawItem(arg, allowedPaths, allowGitUnmanagedFiles) ??
      findUnsafeItem(keyValueMatch[1], allowedPaths, allowGitUnmanagedFiles)
    );
  }

  // file:// pattern — references the local filesystem
  const fileMatch = arg.match(/^file:\/\/(.+)$/i);
  if (fileMatch) {
    return (
      findUnsafeRawItem(arg, allowedPaths, allowGitUnmanagedFiles) ??
      findUnsafeRawItem(
        `/${fileMatch[1]}`,
        allowedPaths,
        allowGitUnmanagedFiles,
      )
    );
  }
  return findUnsafeRawItem(arg, allowedPaths, allowGitUnmanagedFiles);
}

/**
 * @param {string} arg
 * @param {string[]} [allowedPaths=[]] - Additional allowed paths (outside working directory)
 * @param {boolean} [allowGitUnmanagedFiles=false] - Allow access to git-unmanaged files
 * @returns {UnsafeToolInput | undefined}
 */
function findUnsafeRawItem(
  arg,
  allowedPaths = [],
  allowGitUnmanagedFiles = false,
) {
  const workingDir = process.cwd();

  // Note: An argument can be a command option (e.g., '-l').
  // It will then create an absolute path like `/path/to/project/-l`.
  const absPath = path.resolve(arg);

  const realPath = resolveRealPath(absPath);
  const approvalPath = {
    input: arg,
    resolved: realPath !== absPath ? realPath : undefined,
  };
  if (!realPath) {
    return {
      reason: "cannot resolve path (broken or circular symlink)",
      path: approvalPath,
    };
  }

  // Disallow any input that contains ".." as a path segment (directory traversal)
  // Example:
  // - When write_file is allowed for ^safe-dir/.+
  // - "safe-dir/../unsafe-path" should be disallowed
  // This check must happen before allowedPaths check for security
  if (arg.split(path.sep).includes("..")) {
    return {
      reason: "path traversal (..) is not allowed",
      path: approvalPath,
    };
  }

  // .git is always unsafe and cannot be overridden by allowedPaths: writing
  // hooks or config there makes the user's later git commands run agent-planted
  // code.
  if (isInsideGitDirectory(realPath) || isInsideGitDirectory(absPath)) {
    return {
      reason: "path is inside the .git directory",
      path: approvalPath,
    };
  }

  // Built-in allowed paths (memory, tmp, claude-code-plugins) are always safe.
  // This check must come before the .plain-agent/ block below.
  if (isInBuiltinAllowedPath(realPath)) {
    return undefined;
  }

  // Any other path under .plain-agent/ is unsafe and cannot be overridden
  // by allowedPaths. This prevents privilege escalation via sandbox scripts
  // or config files even when explicitly listed in allowedPaths.
  if (isInsideProjectMetadataDir(realPath)) {
    return {
      reason: `path is inside the project metadata directory (${AGENT_PROJECT_METADATA_DIR}/)`,
      path: approvalPath,
    };
  }

  // Path must be inside the working directory or in user-configured allowed paths
  if (
    !isInsideWorkingDirectory(realPath, workingDir) &&
    !isInUserAllowedPath(realPath, allowedPaths)
  ) {
    return {
      reason: "path is outside the working directory and not in allowedPaths",
      path: approvalPath,
    };
  }

  // Deny git-unmanaged files (outside git repo or git-ignored)
  if (!allowGitUnmanagedFiles && !isGitManaged(realPath)) {
    return {
      reason: "path is not managed by git (ignored or outside a repository)",
      path: approvalPath,
    };
  }

  return undefined;
}

/**
 * @param {string} absPath
 * @returns {string | undefined}
 */
function resolveRealPath(absPath) {
  let currentPath = absPath;
  const missingPathParts = [];

  while (true) {
    const realPathResult = noThrowSync(() => fs.realpathSync(currentPath));
    if (!(realPathResult instanceof Error)) {
      return path.resolve(realPathResult, ...missingPathParts);
    }

    if (
      /** @type {NodeJS.ErrnoException} */ (realPathResult).code !== "ENOENT"
    ) {
      return undefined;
    }

    const stats = noThrowSync(() => fs.lstatSync(currentPath));
    if (!(stats instanceof Error)) {
      return undefined;
    }
    if (/** @type {NodeJS.ErrnoException} */ (stats).code !== "ENOENT") {
      return undefined;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }

    missingPathParts.unshift(path.basename(currentPath));
    currentPath = parentPath;
  }
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
 * Check if the path is inside a .git directory. Matching any ".git" path
 * segment also covers nested repositories.
 * @param {string} targetPath - Must be an absolute path.
 * @returns {boolean}
 */
function isInsideGitDirectory(targetPath) {
  return targetPath.toLowerCase().split(path.sep).includes(".git");
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
      ["-C", gitRoot, "check-ignore", "--no-index", "-q", "--", absPath],
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
