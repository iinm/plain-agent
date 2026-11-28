/**
 * @import { Readable } from "node:stream"
 * @import { SandboxConfig } from "./config"
 * @import { ResolvedToolPath } from "./toolInputValidator.mjs"
 */

import { spawn } from "node:child_process";
import { constants, createReadStream, realpathSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { AGENT_MEMORY_DIR } from "./env.mjs";
import { sandboxCommand } from "./sandboxCommand.mjs";
import { isGitManaged, resolveRealPath } from "./toolInputValidator.mjs";
import { noThrowSync } from "./utils/noThrow.mjs";

const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;
const PATH_INSPECTION_TIMEOUT_MS = 10_000;
const MAX_PATH_FACTS_BYTES = 64 * 1024;

// Keep the input in an argv entry. Preserve trailing newlines in paths and
// use NUL separators so whitespace in an actual filename stays unambiguous.
const INSPECT_SANDBOX_FILE = `
working_dir=$(pwd -P && printf .) || exit 1
working_dir=\${working_dir%??}
ancestor=$1
suffix=
while [ ! -e "$ancestor" ]; do
  [ ! -L "$ancestor" ] || exit 1
  case "$ancestor" in
    */) ancestor=\${ancestor%/}; ancestor=\${ancestor:-/} ;;
    */*) suffix="/\${ancestor##*/}$suffix"; ancestor=\${ancestor%/*}; ancestor=\${ancestor:-/} ;;
    *) suffix="/$ancestor$suffix"; ancestor=. ;;
  esac
done
canonical=$(realpath -- "$ancestor" && printf .) || exit 1
canonical=\${canonical%??}
real_path=$canonical
if [ -n "$suffix" ]; then
  [ -d "$canonical" ] || exit 1
  real_path="\${canonical%/}$suffix"
fi
directory=$canonical
if [ ! -d "$directory" ]; then directory=\${directory%/*}; fi
git -C "\${directory:-/}" check-ignore --no-index -q -- "$real_path" 2>/dev/null
git_status=$?
printf '%s\\000%s\\000%s\\000' "$working_dir" "$real_path" "$git_status"
`;

/** @typedef {{ key: "filePath" | "memoryPath", within?: string }} FileTargetSpec */
/** @typedef {ResolvedToolPath & { inputPath: string }} FileTarget */

/** @type {FileTargetSpec} */
export const FILE_TARGET = { key: "filePath" };
/** @type {FileTargetSpec} */
export const MEMORY_TARGET = { key: "memoryPath", within: AGENT_MEMORY_DIR };

/** @typedef {(filePath: string, target?: ResolvedToolPath) => boolean} FileReadPolicy */

/**
 * @typedef {Object} FileAccess
 * @property {(input: Record<string, unknown>, spec: FileTargetSpec, signal?: AbortSignal) => Promise<FileTarget>} resolveToolTarget
 * @property {(target: FileTarget, canRead: FileReadPolicy, signal?: AbortSignal) => Promise<AuthorizedRead | undefined>} authorizeRead
 * @property {<T>(filePath: string, useStream: (stream: Readable) => Promise<T>) => Promise<T>} readStream
 * @property {(filePath: string, maxBytes?: number) => Promise<Buffer>} readFile
 * @property {(filePath: string, content: string, options?: {createParents?: boolean}) => Promise<void>} writeFile
 */

/**
 * A read authorized for a particular source. The identifier is opaque to
 * callers. A local read may return undefined if its source changed.
 *
 * @typedef {Object} AuthorizedRead
 * @property {string} source
 * @property {(maxBytes?: number) => Promise<Buffer | undefined>} read
 */

export class FileSizeLimitError extends Error {
  /** @param {number} bytesRead */
  constructor(bytesRead) {
    super("File exceeds the read size limit");
    this.bytesRead = bytesRead;
  }
}

/**
 * Select the filesystem for all built-in operations. A configured sandbox
 * always handles the I/O, independently of rules for model-chosen commands.
 *
 * @param {SandboxConfig} [sandbox]
 * @param {Record<string, string>} [env]
 * @returns {FileAccess}
 */
export function createFileAccess(sandbox, env) {
  const sandboxBackend = sandbox ? sandboxFileAccess(sandbox, env) : undefined;
  const backend = sandboxBackend ?? localFileAccess();

  /** @param {string} filePath @param {number} [maxBytes] @param {AbortSignal} [signal] */
  const readFile = (filePath, maxBytes, signal) =>
    backend.readStream(
      filePath,
      (stream) => collectBytes(stream, maxBytes ?? Number.POSITIVE_INFINITY),
      maxBytes,
      signal,
    );

  /** @type {WeakMap<FileTargetSpec, WeakMap<Record<string, unknown>, Promise<FileTarget>>>} */
  const targetsBySpec = new WeakMap();

  /**
   * @param {Record<string, unknown>} input
   * @param {FileTargetSpec} spec
   * @param {AbortSignal} [signal]
   */
  async function resolveToolTarget(input, spec, signal) {
    let toolTargets = targetsBySpec.get(spec);
    if (!toolTargets) {
      toolTargets = new WeakMap();
      targetsBySpec.set(spec, toolTargets);
    }
    const planned = toolTargets.get(input);
    if (planned) return planned;

    const inputPath = input[spec.key];
    if (
      typeof inputPath !== "string" ||
      !inputPath ||
      inputPath.includes("\0")
    ) {
      throw new Error("Expected a non-empty file path without null bytes");
    }

    const target = (async () => {
      const resolved = sandboxBackend
        ? await sandboxBackend.inspectPath(inputPath, signal)
        : resolveLocalPath(inputPath);
      if (spec.within) {
        const directory = path.resolve(resolved.workingDir, spec.within);
        if (
          !isWithin(directory, path.resolve(resolved.workingDir, inputPath)) ||
          !isWithin(directory, resolved.realPath)
        ) {
          throw new Error(
            `Access denied: memoryPath must be within ${spec.within}`,
          );
        }
      }
      return { ...resolved, inputPath };
    })();

    // An input object belongs to one tool call. Approval, preview and execution
    // share its filesystem resolution without changing the model's arguments.
    toolTargets.set(input, target);
    return target;
  }

  return {
    resolveToolTarget,
    async authorizeRead(target, canRead, signal) {
      if (!canRead(target.inputPath, target)) return undefined;
      if (!sandboxBackend) return authorizeLocalRead(target.realPath);
      return {
        source: target.realPath,
        read: (maxBytes) => readFile(target.realPath, maxBytes, signal),
      };
    },
    readStream: backend.readStream,
    readFile,
    writeFile: backend.writeFile,
  };
}

/**
 * @typedef {Object} FileBackend
 * @property {<T>(filePath: string, useStream: (stream: Readable) => Promise<T>, maxBytes?: number, signal?: AbortSignal) => Promise<T>} readStream
 * @property {FileAccess["writeFile"]} writeFile
 */

/** @param {string} inputPath @returns {ResolvedToolPath} */
function resolveLocalPath(inputPath) {
  const workingDir = process.cwd();
  const existing = noThrowSync(() => realpathSync(inputPath));
  const realPath =
    existing instanceof Error
      ? resolveRealPath(path.resolve(workingDir, inputPath))
      : existing;
  if (!realPath) throw new Error("Could not resolve the file path");
  return { workingDir, realPath, gitManaged: isGitManaged(realPath) };
}

/** @param {string} directory @param {string} filePath */
function isWithin(directory, filePath) {
  const relative = path.relative(directory, filePath);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

/** @param {string} resolvedPath @returns {AuthorizedRead | undefined} */
function authorizeLocalRead(resolvedPath) {
  const target = noThrowSync(() => {
    const stats = statSync(resolvedPath);
    if (!stats.isFile()) return undefined;
    return { resolvedPath, dev: stats.dev, ino: stats.ino };
  });
  if (!target || target instanceof Error) return undefined;

  return {
    source: JSON.stringify(target),
    async read(maxBytes = Number.POSITIVE_INFINITY) {
      const opened = await fs.open(
        target.resolvedPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        const stats = await opened.stat();
        if (
          !stats.isFile() ||
          stats.dev !== target.dev ||
          stats.ino !== target.ino
        ) {
          return undefined;
        }
        if (stats.size > maxBytes) throw new FileSizeLimitError(stats.size);
        return await collectBytes(
          opened.createReadStream({ autoClose: false }),
          maxBytes,
        );
      } finally {
        await opened.close();
      }
    },
  };
}

/** @param {Readable} stream @param {number} maxBytes */
async function collectBytes(stream, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maxBytes) throw new FileSizeLimitError(length);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

/** @returns {FileBackend} */
function localFileAccess() {
  return {
    async readStream(filePath, useStream, maxBytes = Number.POSITIVE_INFINITY) {
      if (maxBytes === Number.POSITIVE_INFINITY) {
        const stream = createReadStream(filePath);
        try {
          return await useStream(stream);
        } finally {
          stream.destroy();
        }
      }

      // Size-limited readers only accept regular files.
      const file = await fs.open(
        filePath,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        const stats = await file.stat();
        if (!stats.isFile()) throw new Error("Expected a regular file");
        if (stats.size > maxBytes) throw new FileSizeLimitError(stats.size);
        return await useStream(file.createReadStream({ autoClose: false }));
      } finally {
        await file.close();
      }
    },
    async writeFile(filePath, content, { createParents = false } = {}) {
      const target = createParents ? path.resolve(filePath) : filePath;
      if (createParents)
        await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    },
  };
}

/**
 * @param {SandboxConfig} sandbox
 * @param {Record<string, string>} [env]
 * @returns {FileBackend & {inspectPath: (filePath: string, signal?: AbortSignal) => Promise<ResolvedToolPath>}}
 */
function sandboxFileAccess(sandbox, env) {
  /** @param {string} command @param {string[]} args @param {AbortSignal} [signal] */
  function start(command, args, signal) {
    signal?.throwIfAborted();
    const invocation = sandboxCommand(sandbox, { command, args });
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(invocation.command, invocation.args, {
      detached: useProcessGroup,
      env: {
        PWD: process.env.PWD,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        ...env,
      },
    });

    let stderr = "";
    // The reader receives stream errors; write-only operations drain stdout.
    child.stdout.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk.slice(0, Math.max(0, 4096 - stderr.length));
    });

    /** @type {Error | undefined} */
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });

    /** @param {Error} [error] */
    function stop(error) {
      if (useProcessGroup && child.pid) {
        try {
          // The wrapper can have descendants keeping stdout open.
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      child.stdin.destroy();
      child.stdout.destroy(error);
      child.stderr.destroy();
    }

    function onTimeout() {
      spawnError = new Error("Timed out");
      stop(spawnError);
    }

    const timeout = setTimeout(onTimeout, PROCESS_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", onTimeout, { once: true });

    /** @type {Promise<Error | undefined>} */
    const result = new Promise((resolve) => {
      child.once("close", (code, exitSignal) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onTimeout);
        if (!spawnError && code === 0) {
          resolve(undefined);
          return;
        }
        const detail =
          spawnError?.message ?? (stderr.trim() || String(exitSignal ?? code));
        resolve(
          new Error(`Sandbox file operation (${command}) failed: ${detail}`),
        );
      });
    });
    return { child, result, stop };
  }

  /** @param {string} command @param {string[]} args @param {string} [content] @param {AbortSignal} [signal] */
  async function run(command, args, content, signal) {
    const { child, result } = start(command, args, signal);
    child.stdout.resume();

    // Observe stdin errors even when the wrapper exits before reading input.
    const sent = finished(child.stdin, { cleanup: true }).catch(
      (error) => /** @type {Error} */ (error),
    );
    child.stdin.end(content);

    const failure = (await result) ?? (await sent);
    if (failure) throw failure;
  }

  /**
   * @template T
   * @param {string} command
   * @param {string[]} args
   * @param {(stream: Readable) => Promise<T>} useStream
   * @param {AbortSignal} [signal]
   */
  async function readCommand(command, args, useStream, signal) {
    const { child, result, stop } = start(command, args, signal);
    child.stdin.on("error", () => {});
    child.stdin.end();
    try {
      const output = await useStream(child.stdout);
      if (
        !child.stdout.readableEnded &&
        !child.stdout.destroyed &&
        child.exitCode === null
      ) {
        // A line-range read can finish before cat reaches EOF.
        stop();
        await result;
        return output;
      }

      const failure = await result;
      if (failure) throw failure;
      return output;
    } finally {
      if (child.exitCode === null && child.signalCode === null) stop();
      await result;
    }
  }

  return {
    async inspectPath(filePath, signal) {
      const deadline =
        signal ?? AbortSignal.timeout(PATH_INSPECTION_TIMEOUT_MS);
      const output = await readCommand(
        "sh",
        ["-c", INSPECT_SANDBOX_FILE, "plain-agent-inspect", filePath],
        (stream) => collectBytes(stream, MAX_PATH_FACTS_BYTES),
        deadline,
      ).finally(() => deadline.throwIfAborted());
      const fields = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(output)
        .split("\0");
      const [workingDir, realPath, gitStatus, terminator] = fields;
      if (
        fields.length !== 4 ||
        terminator !== "" ||
        !path.isAbsolute(workingDir) ||
        !path.isAbsolute(realPath)
      ) {
        throw new Error("Invalid sandbox file metadata");
      }
      return {
        workingDir,
        realPath: path.normalize(realPath),
        gitManaged: gitStatus === "1",
      };
    },
    async readStream(filePath, useStream, maxBytes, signal) {
      // cat interprets a lone "-" as stdin even after "--".
      const operand = filePath === "-" ? "./-" : filePath;
      if (maxBytes !== undefined && maxBytes !== Number.POSITIVE_INFINITY)
        await run("test", ["-f", operand], undefined, signal);
      return await readCommand("cat", ["--", operand], useStream, signal);
    },
    async writeFile(filePath, content, { createParents = false } = {}) {
      const operand = filePath === "-" ? "./-" : filePath;
      if (createParents)
        await run("mkdir", ["-p", "--", path.dirname(operand)]);
      await run("tee", ["--", operand], content);
    },
  };
}
