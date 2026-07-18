import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appendSessionLine,
  listSessions,
  loadSession,
  SESSION_FORMAT_VERSION,
  sessionFilePath,
} from "./sessionStore.mjs";

/** @type {string} */
let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plain-session-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const metadata = {
  sessionId: "2026-05-10-0803-a7k",
  modelName: "claude-sonnet-4-6+thinking-high",
  workingDir: "/w",
  startTime: "2026-05-10T08:03:00.000Z",
};
const systemMessage = {
  role: "system",
  content: [{ type: "text", text: "system" }],
};
const userMessage = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
};

/** @param {string} sessionId @param {object} event */
async function append(sessionId, event) {
  await appendSessionLine(
    sessionId,
    JSON.stringify({ ...event, timestamp: "2026-05-10T08:03:01.000Z" }),
    { dir: tmpDir },
  );
}

/** @param {string} sessionId */
async function start(sessionId = metadata.sessionId) {
  await append(sessionId, {
    type: "session_start",
    sessionFormatVersion: SESSION_FORMAT_VERSION,
    ...metadata,
    sessionId,
  });
}

describe("sessionFilePath", () => {
  it("uses the jsonl extension", () => {
    // when:
    const result = sessionFilePath("abc", { dir: "/tmp/sessions" });
    // then:
    assert.equal(result, path.join("/tmp/sessions", "abc.jsonl"));
  });
});

describe("appendSessionLine + loadSession", () => {
  it("replays messages, resets, usage, and subagent transitions", async () => {
    // given:
    await start();
    await append(metadata.sessionId, {
      type: "message",
      message: systemMessage,
    });
    await append(metadata.sessionId, { type: "message", message: userMessage });
    await append(metadata.sessionId, {
      type: "messages_reset",
      messages: [systemMessage],
    });
    const subagent = {
      name: "researcher",
      goal: "investigate",
      switchMessageIndex: 1,
    };
    await append(metadata.sessionId, { type: "subagent_switched", subagent });
    await append(metadata.sessionId, {
      type: "subagent_switched",
      subagent: null,
    });
    await append(metadata.sessionId, { type: "subagent_switched", subagent });
    await append(metadata.sessionId, {
      type: "token_usage",
      usage: { inputTokens: 4 },
    });

    // when:
    const loaded = await loadSession(metadata.sessionId, { dir: tmpDir });

    // then:
    assert.deepEqual(loaded, {
      version: SESSION_FORMAT_VERSION,
      ...metadata,
      messages: [systemMessage],
      subagentState: { subagents: [subagent], subagentCount: 2 },
      tokenUsageHistory: [{ inputTokens: 4 }],
    });
  });

  it("skips corrupt event lines and later session_start events", async () => {
    // given:
    await start();
    await appendSessionLine(metadata.sessionId, "not json", { dir: tmpDir });
    await append(metadata.sessionId, {
      type: "session_start",
      sessionFormatVersion: 999,
      ...metadata,
    });
    await append(metadata.sessionId, { type: "message", message: userMessage });

    // when:
    const loaded = await loadSession(metadata.sessionId, { dir: tmpDir });

    // then:
    assert.deepEqual(loaded?.messages, [userMessage]);
  });

  it("returns null for a missing stream", async () => {
    // when:
    const loaded = await loadSession("missing", { dir: tmpDir });
    // then:
    assert.equal(loaded, null);
  });

  it("throws for a format-version mismatch", async () => {
    // given:
    await append(metadata.sessionId, {
      type: "session_start",
      sessionFormatVersion: 999,
      ...metadata,
    });
    // when/then:
    await assert.rejects(
      () => loadSession(metadata.sessionId, { dir: tmpDir }),
      /Unsupported session file version/,
    );
  });
});

describe("listSessions", () => {
  it("lists only valid jsonl streams in mtime-descending order", async () => {
    // given:
    await start("older");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await start("newer");
    await fs.writeFile(path.join(tmpDir, "ignored.json"), "{}", "utf8");
    await fs.writeFile(path.join(tmpDir, "bad.jsonl"), "not json\n", "utf8");

    // when:
    const sessions = await listSessions({ dir: tmpDir });

    // then:
    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["newer", "older"],
    );
    assert.ok(
      sessions.every((session) => typeof session.lastUpdatedAt === "string"),
    );
    assert.ok(sessions.every((session) => !("messageCount" in session)));
  });
});
