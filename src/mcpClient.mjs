import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * @typedef {Object} CreateMCPClientOptions
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} [env]
 * @property {"inherit" | "ignore" | "pipe" | string} [stderr]
 * @property {string} [protocolVersion]
 * @property {{ name: string, version: string }} [clientInfo]
 * @property {Record<string, unknown>} [capabilities]
 * @property {(method: string, params?: unknown) => void} [onNotification]
 */

/**
 * Spawn an MCP server process and return an initialized client.
 * @param {CreateMCPClientOptions} options
 * @returns {Promise<MCPClient>}
 */
export async function createMCPClient(options) {
  const transport = new StdioTransport(options.command, options.args, {
    env: options.env,
    stderr: options.stderr,
    onNotification: options.onNotification,
  });

  const client = new MCPClient(transport);
  try {
    await client.initialize({
      protocolVersion: options.protocolVersion,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
    });
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
  return client;
}

/**
 * MCP protocol client.
 * Delegates transport concerns to a transport object.
 */
export class MCPClient {
  /** @type {StdioTransport} */
  #transport;
  #closed = false;

  /**
   * @param {StdioTransport} transport
   */
  constructor(transport) {
    this.#transport = transport;
  }

  /**
   * @param {Object} [options]
   * @param {string} [options.protocolVersion]
   * @param {{ name: string, version: string }} [options.clientInfo]
   * @param {Record<string, unknown>} [options.capabilities]
   * @returns {Promise<any>}
   */
  async initialize(options = {}) {
    if (this.#closed) {
      throw new Error("MCP client is closed");
    }
    const result = await this.#transport.request("initialize", {
      protocolVersion: options.protocolVersion ?? "2025-03-26",
      capabilities: options.capabilities ?? {},
      clientInfo: options.clientInfo ?? {
        name: "plain-agent",
        version: "0.0.0",
      },
    });
    this.#transport.notify("notifications/initialized");
    return result;
  }

  /**
   * @returns {Promise<{ tools: Array<{ name: string, description?: string, inputSchema: Record<string, unknown> }> }>}
   */
  async listTools() {
    if (this.#closed) {
      throw new Error("MCP client is closed");
    }
    return this.#transport.request("tools/list", {});
  }

  /**
   * @param {{ name: string, arguments?: Record<string, unknown> }} params
   * @returns {Promise<{ content?: Array<{ type: string, text?: string, data?: string, mimeType?: string }>, isError?: boolean }>}
   */
  async callTool(params) {
    if (this.#closed) {
      throw new Error("MCP client is closed");
    }
    return this.#transport.request("tools/call", params);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport.close();
  }
}

/**
 * @typedef {Object} StdioTransportOptions
 * @property {Record<string, string>} [env]
 * @property {"inherit" | "ignore" | "pipe" | string} [stderr]
 * @property {(method: string, params?: unknown) => void} [onNotification]
 */

/**
 * JSON-RPC 2.0 transport over stdio.
 * Manages the child process lifecycle and message passing.
 */
export class StdioTransport {
  /** @type {import("node:child_process").ChildProcess} */
  #process;
  /** @type {import("node:readline").Interface} */
  #rl;
  #nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (reason: any) => void, timer: NodeJS.Timeout }>} */
  #pendingRequests = new Map();
  #closed = false;
  /** @type {Error | undefined} */
  #earlyExitError;
  /** @type {((line: string) => void)} */
  #onLine;
  /** @type {((code: number | null) => void)} */
  #onClose;
  /** @type {((err: Error) => void)} */
  #onError;
  /** @type {number | undefined} */
  #stderrFd;
  /** @type {((method: string, params?: unknown) => void) | undefined} */
  #onNotification;

  /**
   * @param {string} command
   * @param {string[]} [args]
   * @param {StdioTransportOptions} [options]
   */
  constructor(command, args, options = {}) {
    const defaultEnv = {
      PWD: process.env.PWD || "",
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
    };

    /** @type {"inherit" | "ignore" | "pipe" | number} */
    let stderrValue = "ignore";
    if (
      options.stderr === "inherit" ||
      options.stderr === "ignore" ||
      options.stderr === "pipe"
    ) {
      stderrValue = options.stderr;
    } else if (typeof options.stderr === "string") {
      this.#stderrFd = openSync(options.stderr, "a");
      stderrValue = this.#stderrFd;
    }

    const childProcess = spawn(command, args || [], {
      env: { ...defaultEnv, ...options.env },
      stdio: /** @type {import("node:child_process").StdioOptions} */ ([
        "pipe",
        "pipe",
        stderrValue,
      ]),
    });

    this.#process = childProcess;
    this.#onNotification = options.onNotification;

    if (!childProcess.stdout) {
      throw new Error("MCP server stdout is not available");
    }
    this.#rl = createInterface({ input: childProcess.stdout });

    this.#onLine = (line) => this.#handleLine(line);
    this.#rl.on("line", this.#onLine);

    this.#onClose = (code) => this.#handleProcessClose(code);
    childProcess.on("close", this.#onClose);

    this.#onError = (err) => this.#handleProcessError(err);
    childProcess.on("error", this.#onError);
  }

  /**
   * @returns {import("node:child_process").ChildProcess}
   */
  get process() {
    return this.#process;
  }

  /**
   * @param {string} line
   */
  #handleLine(line) {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (!("id" in msg)) {
        this.#onNotification?.(msg.method, msg.params);
        return;
      }
      if (this.#pendingRequests.has(msg.id)) {
        const pending = this.#pendingRequests.get(msg.id);
        if (!pending) return;
        this.#pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);
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
  }

  /**
   * @param {number | null} code
   */
  #handleProcessClose(code) {
    const err = new Error(`MCP server exited with code ${code}`);
    this.#earlyExitError = err;
    this.#rejectAllPending(err);
  }

  /**
   * @param {Error} err
   */
  #handleProcessError(err) {
    this.#earlyExitError = err;
    this.#rejectAllPending(err);
  }

  /**
   * @param {Error} error
   */
  #rejectAllPending(error) {
    for (const [, { reject, timer }] of this.#pendingRequests) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pendingRequests.clear();
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(method, params, timeoutMs = 30000) {
    if (this.#closed) {
      return Promise.reject(new Error("MCP client is closed"));
    }
    if (this.#earlyExitError) {
      return Promise.reject(this.#earlyExitError);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pendingRequests.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.#process.stdin?.write(`${msg}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
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
  notify(method, params) {
    if (this.#closed || this.#earlyExitError) return;
    const msg = JSON.stringify(
      params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method },
    );
    this.#process.stdin?.write(`${msg}\n`, () => {
      // Ignore write errors in notifications
    });
  }

  /**
   * @param {NodeJS.Signals} [signal]
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async close(signal = "SIGTERM", timeoutMs = 5000) {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAllPending(new Error("MCP client is closed"));
    this.#rl.off("line", this.#onLine);
    this.#rl.close();
    this.#process.stdin?.end();
    this.#process.off("close", this.#onClose);
    this.#process.off("error", this.#onError);

    const closePromise = new Promise((resolve) => {
      if (
        this.#process.exitCode !== null ||
        this.#process.signalCode !== null
      ) {
        resolve(undefined);
        return;
      }
      const timer = setTimeout(() => {
        this.#process.kill("SIGKILL");
        resolve(undefined);
      }, timeoutMs);
      this.#process.once("close", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });

    this.#process.kill(signal);
    await closePromise;

    if (this.#stderrFd !== undefined) {
      try {
        closeSync(this.#stderrFd);
      } catch {
        // ignore
      }
    }
  }
}
