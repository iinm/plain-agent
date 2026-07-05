/**
 * @import { Message, ProviderTokenUsage } from "./model"
 * @import { ToolUsePattern } from "./tool"
 */

import fs from "node:fs/promises";
import path from "node:path";
import { SESSIONS_DIR } from "./env.mjs";

/** Current on-disk format version. Bump on breaking changes. */
export const SESSION_FILE_VERSION = 1;

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
 * @property {string} lastUpdatedAt - ISO 8601
 * @property {Message[]} messages
 * @property {SubagentSerializedState} subagentState
 * @property {ToolUsePattern[]} allowedToolUseInSession
 * @property {ProviderTokenUsage[]} tokenUsageHistory
 */

/**
 * @typedef {Object} SessionSummary
 * @property {string} sessionId
 * @property {string} modelName
 * @property {string} workingDir
 * @property {string} startTime
 * @property {string} lastUpdatedAt
 * @property {number} messageCount
 * @property {string} firstUserMessage
 */

/**
 * Resolve the path to a session file.
 * @param {string} sessionId
 * @param {{ dir?: string }} [options]
 */
export function sessionFilePath(sessionId, options = {}) {
  const dir = options.dir ?? SESSIONS_DIR;
  return path.join(dir, `${sessionId}.json`);
}

/**
 * Persist a session state atomically.
 *
 * Writes to a process-unique temp file in the same directory, then renames
 * it over the target path. Same-directory rename is atomic on POSIX, so a
 * crash during write leaves either the previous file or the new one — never
 * a half-written file.
 *
 * @param {SessionState} state
 * @param {{ dir?: string }} [options]
 * @returns {Promise<void>}
 */
export async function saveSession(state, options = {}) {
  const dir = options.dir ?? SESSIONS_DIR;
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${state.sessionId}.json`);
  const tmp = `${target}.tmp.${process.pid}`;
  const json = JSON.stringify(state, null, 2);
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, target);
}

/**
 * Load a session by id. Returns null when the file does not exist.
 * Throws on parse errors or unsupported versions.
 *
 * @param {string} sessionId
 * @param {{ dir?: string }} [options]
 * @returns {Promise<SessionState | null>}
 */
export async function loadSession(sessionId, options = {}) {
  const dir = options.dir ?? SESSIONS_DIR;
  const target = path.join(dir, `${sessionId}.json`);
  /** @type {string} */
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

  const parsed = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.version !== "number"
  ) {
    throw new Error(`Invalid session file: ${target}`);
  }
  if (parsed.version !== SESSION_FILE_VERSION) {
    throw new Error(
      `Unsupported session file version ${parsed.version} at ${target} (expected ${SESSION_FILE_VERSION})`,
    );
  }
  return /** @type {SessionState} */ (parsed);
}

/**
 * List sessions in the sessions directory, sorted by lastUpdatedAt descending.
 * Malformed files are silently skipped.
 *
 * @param {{ dir?: string }} [options]
 * @returns {Promise<SessionSummary[]>}
 */
export async function listSessions(options = {}) {
  const dir = options.dir ?? SESSIONS_DIR;
  /** @type {string[]} */
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
    if (!name.endsWith(".json")) continue;
    if (name.includes(".tmp.")) continue;
    const sessionId = name.slice(0, -".json".length);
    try {
      const state = await loadSession(sessionId, { dir });
      if (!state) continue;
      summaries.push({
        sessionId: state.sessionId,
        modelName: state.modelName,
        workingDir: state.workingDir,
        startTime: state.startTime,
        lastUpdatedAt: state.lastUpdatedAt,
        messageCount: state.messages.length,
        firstUserMessage: extractFirstUserMessage(state.messages),
      });
    } catch {
      // Skip malformed or version-mismatched files so a single bad file
      // doesn't break listing.
    }
  }

  summaries.sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
  return summaries;
}

const FIRST_USER_MESSAGE_MAX_LENGTH = 80;

/**
 * Extract the first user message text from a message list.
 * Returns the first `type === "text"` content from the first `role === "user"`
 * message, with newlines replaced by spaces and truncated to
 * {@link FIRST_USER_MESSAGE_MAX_LENGTH} characters.
 *
 * @param {Message[]} messages
 * @returns {string}
 */
function extractFirstUserMessage(messages) {
  const userMsg = messages.find((m) => m.role === "user");
  if (!userMsg) return "";
  const textPart = userMsg.content.find((c) => c.type === "text");
  if (textPart?.type !== "text") return "";
  const normalized = textPart.text.replace(/\n/g, " ");
  if (normalized.length <= FIRST_USER_MESSAGE_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, FIRST_USER_MESSAGE_MAX_LENGTH)}…`;
}
