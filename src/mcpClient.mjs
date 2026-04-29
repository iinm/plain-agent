import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class MCPClient {
  /** @type {import("node:child_process").ChildProcess} */
  #process;
  /** @type {import("node:readline").Interface} */
  #rl;
  #nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (reason: any) => void }>} */
  #pendingRequests = new Map();
  #closed = false;
  /** @type {Error | undefined} */
  #earlyExitError;
  /** @type {((line: string) => void) | undefined} */
  #onLine;
  /** @type {((code: number | null) => void) | undefined} */
  #onClose;
  /** @type {((err: Error) => void) | undefined} */
  #onError;

  /**
   * @param {import("node:child_process").ChildProcess} childProcess
   */
  constructor(childProcess) {
    this.#process = childProcess;
    if (!childProcess.stdout) {
      throw new Error("MCP server stdout is not available");
    }
    this.#rl = createInterface({ input: childProcess.stdout });

    this.#onLine = (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if ("id" in msg && this.#pendingRequests.has(msg.id)) {
          const pending = this.#pendingRequests.get(msg.id);
          if (!pending) return;
          this.#pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(
              new Error(msg.error.message || JSON.stringify(msg.error)),
            );
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    };
    this.#rl.on("line", this.#onLine);

    this.#onClose = (code) => {
      const err = new Error(`MCP server exited with code ${code}`);
      this.#earlyExitError = err;
      this.#rejectAllPending(err);
    };
    childProcess.on("close", this.#onClose);

    this.#onError = (err) => {
      this.#earlyExitError = err;
      this.#rejectAllPending(err);
    };
    childProcess.on("error", this.#onError);
  }

  /**
   * @param {Error} error
   */
  #rejectAllPending(error) {
    for (const [, { reject }] of this.#pendingRequests) {
      reject(error);
    }
    this.#pendingRequests.clear();
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  #request(method, params) {
    if (this.#closed) {
      return Promise.reject(new Error("MCP client is closed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.#process.stdin?.write(`${msg}\n`, (err) => {
        if (err) {
          this.#pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  #notify(method, params) {
    if (this.#closed) return;
    const msg = JSON.stringify(
      params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method },
    );
    this.#process.stdin?.write(`${msg}\n`, () => {
      // Ignore write errors in notifications
    });
  }

  async initialize() {
    if (this.#earlyExitError) {
      throw this.#earlyExitError;
    }
    const result = await this.#request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "plain-agent", version: "0.0.0" },
    });
    this.#notify("notifications/initialized");
    return result;
  }

  /**
   * @returns {Promise<{ tools: Array<{ name: string, description?: string, inputSchema: Record<string, unknown> }> }>}
   */
  async listTools() {
    return await this.#request("tools/list", {});
  }

  /**
   * @param {{ name: string, arguments?: Record<string, unknown> }} params
   * @returns {Promise<{ content?: Array<{ type: string, text?: string, data?: string, mimeType?: string }>, isError?: boolean }>}
   */
  async callTool(params) {
    return await this.#request("tools/call", params);
  }

  async close() {
    this.#closed = true;
    this.#rejectAllPending(new Error("MCP client is closed"));
    if (this.#onLine) this.#rl.off("line", this.#onLine);
    this.#rl.close();
    this.#process.stdin?.end();
    if (this.#onClose) this.#process.off("close", this.#onClose);
    if (this.#onError) this.#process.off("error", this.#onError);
    this.#process.kill();
  }
}

/**
 * @typedef {Object} SpawnMCPServerOptions
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} [env]
 * @property {import("node:fs/promises").FileHandle | number | string} [stderr]
 */

/**
 * Spawn an MCP server process and return an initialized client.
 * @param {SpawnMCPServerOptions} options
 * @returns {Promise<MCPClient>}
 */
export async function createMCPClient(options) {
  const defaultEnv = {
    PWD: process.env.PWD || "",
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
  };

  const stderrFd =
    typeof options.stderr === "string"
      ? options.stderr
      : typeof options.stderr === "number"
        ? options.stderr
        : (options.stderr?.fd ?? "ignore");

  const childProcess = spawn(options.command, options.args || [], {
    env: options.env ? { ...defaultEnv, ...options.env } : undefined,
    stdio: /** @type {import("node:child_process").StdioOptions} */ ([
      "pipe",
      "pipe",
      stderrFd,
    ]),
  });

  // Detect immediate exit (e.g. command not found or immediate crash)
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    throw new Error(
      `MCP server exited with code ${childProcess.exitCode} before initialization`,
    );
  }

  const client = new MCPClient(childProcess);
  try {
    await client.initialize();
  } catch (err) {
    childProcess.kill();
    throw err;
  }
  return client;
}
