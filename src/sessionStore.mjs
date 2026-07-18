/**
 * @import { Message, ProviderTokenUsage } from "./model"
 */

import fs from "node:fs/promises";
import path from "node:path";
import { SESSIONS_DIR } from "./env.mjs";

/** Current on-disk event-stream format version. Bump on breaking changes. */
export const SESSION_FORMAT_VERSION = 2;

/** Event types that are persisted in session JSONL streams. */
export const WRITABLE_EVENT_TYPES = new Set([
  "session_start",
  "message",
  "token_usage",
  "subagent_switched",
  "messages_reset",
  "session_end",
]);

/**
 * @typedef {Object} SubagentSerializedState
 * @property {{name: string, goal: string, switchMessageIndex: number}[]} subagents
 * @property {number} subagentCount
 */

/**
 * @typedef {Object} SessionState
 * @property {number} version
 * @property {string} sessionId
 * @property {string} modelName
 * @property {string} workingDir
 * @property {string} startTime - ISO 8601
 * @property {Message[]} messages
 * @property {SubagentSerializedState} subagentState
 * @property {ProviderTokenUsage[]} tokenUsageHistory
 */

/**
 * @typedef {Object} SessionSummary
 * @property {string} sessionId
 * @property {string} modelName
 * @property {string} workingDir
 * @property {string} startTime
 * @property {string} lastUpdatedAt
 */

/**
 * Resolve the path to a session event stream.
 * @param {string} sessionId
 * @param {{ dir?: string }} [options]
 */
export function sessionFilePath(sessionId, options = {}) {
  const dir = options.dir ?? SESSIONS_DIR;
  return path.join(dir, `${sessionId}.jsonl`);
}

/**
 * Append one JSONL line to a session event stream.
 * @param {string} sessionId
 * @param {string} line
 * @param {{ dir?: string }} [options]
 */
export async function appendSessionLine(sessionId, line, options = {}) {
  const dir = options.dir ?? SESSIONS_DIR;
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(sessionFilePath(sessionId, { dir }), `${line}\n`, "utf8");
}

/**
 * Load a session by replaying its JSONL event stream. Returns null when the
 * file does not exist. Corrupt event lines are ignored.
 *
 * @param {string} sessionId
 * @param {{ dir?: string }} [options]
 * @returns {Promise<SessionState | null>}
 */
export async function loadSession(sessionId, options = {}) {
  const dir = options.dir ?? SESSIONS_DIR;
  const target = sessionFilePath(sessionId, { dir });
  let raw;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (err) {
    if (
      err instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }

  const lines = raw.split("\n");
  /** @type {unknown} */
  let firstEvent;
  for (const line of lines) {
    if (!line) continue;
    try {
      firstEvent = JSON.parse(line);
    } catch {
      throw new Error(`Invalid session file: ${target}`);
    }
    break;
  }
  if (!isSessionStart(firstEvent)) {
    throw new Error(`Invalid session file: ${target}`);
  }
  if (firstEvent.sessionFormatVersion !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `Unsupported session file version ${firstEvent.sessionFormatVersion} at ${target} (expected ${SESSION_FORMAT_VERSION})`,
    );
  }

  /** @type {Message[]} */
  let messages = [];
  /** @type {ProviderTokenUsage[]} */
  const tokenUsageHistory = [];
  /** @type {{name: string, goal: string, switchMessageIndex: number}[]} */
  const subagents = [];
  let subagentCount = 0;

  for (const line of lines.slice(1)) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    switch (event.type) {
      case "message":
        if (event.message) messages.push(event.message);
        break;
      case "messages_reset":
        if (Array.isArray(event.messages)) messages = [...event.messages];
        break;
      case "token_usage":
        if (event.usage) tokenUsageHistory.push(event.usage);
        break;
      case "subagent_switched":
        if (event.subagent && isSubagent(event.subagent)) {
          subagents.push(event.subagent);
          subagentCount++;
        } else if (event.subagent === null) {
          subagents.pop();
        }
        break;
    }
  }

  return {
    version: SESSION_FORMAT_VERSION,
    sessionId: firstEvent.sessionId,
    modelName: firstEvent.modelName,
    workingDir: firstEvent.workingDir,
    startTime: firstEvent.startTime,
    messages,
    subagentState: { subagents, subagentCount },
    tokenUsageHistory,
  };
}

/**
 * List valid session event streams, sorted by most recently modified first.
 * @param {{ dir?: string }} [options]
 * @returns {Promise<SessionSummary[]>}
 */
export async function listSessions(options = {}) {
  const dir = options.dir ?? SESSIONS_DIR;
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (
      err instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }

  /** @type {SessionSummary[]} */
  const summaries = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const target = path.join(dir, name);
      const firstLine = (await fs.readFile(target, "utf8")).split("\n", 1)[0];
      const event = JSON.parse(firstLine);
      if (
        !isSessionStart(event) ||
        event.sessionFormatVersion !== SESSION_FORMAT_VERSION
      )
        continue;
      const stat = await fs.stat(target);
      summaries.push({
        sessionId: event.sessionId,
        modelName: event.modelName,
        workingDir: event.workingDir,
        startTime: event.startTime,
        lastUpdatedAt: stat.mtime.toISOString(),
      });
    } catch {
      // A malformed stream must not prevent listing other sessions.
    }
  }
  summaries.sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
  return summaries;
}

/**
 * @param {unknown} event
 * @returns {event is {
 *   type: "session_start",
 *   sessionFormatVersion: number,
 *   sessionId: string,
 *   modelName: string,
 *   workingDir: string,
 *   startTime: string,
 * }}
 */
function isSessionStart(event) {
  if (!event || typeof event !== "object") return false;
  const candidate = /** @type {Record<string, unknown>} */ (event);
  return (
    candidate.type === "session_start" &&
    typeof candidate.sessionFormatVersion === "number" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.modelName === "string" &&
    typeof candidate.workingDir === "string" &&
    typeof candidate.startTime === "string"
  );
}

/**
 * @param {unknown} subagent
 * @returns {subagent is {name: string, goal: string, switchMessageIndex: number}}
 */
function isSubagent(subagent) {
  if (!subagent || typeof subagent !== "object") return false;
  const candidate = /** @type {Record<string, unknown>} */ (subagent);
  return (
    typeof candidate.name === "string" &&
    typeof candidate.goal === "string" &&
    typeof candidate.switchMessageIndex === "number"
  );
}
