import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  listSessions,
  loadSession,
  persistSessionEvent,
  SESSION_FORMAT_VERSION,
  sessionFileExists,
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
/** @type {import("./model").SystemMessage} */
const systemMessage = {
  role: "system",
  content: [{ type: "text", text: "system" }],
};
/** @type {import("./model").UserMessage} */
const userMessage = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
};

describe("sessionFilePath", () => {
  it("uses the jsonl extension", () => {
    // when:
    const result = sessionFilePath("abc", { dir: "/tmp/sessions" });
    // then:
    assert.equal(result, path.join("/tmp/sessions", "abc.jsonl"));
  });
});

describe("sessionFileExists", () => {
  it("returns false when the session event-stream file is missing", async () => {
    // when:
    const exists = await sessionFileExists("missing", { dir: tmpDir });

    // then:
    assert.equal(exists, false);
  });

  it("returns true when the session event-stream file exists", async () => {
    // given:
    await persistSessionEvent(
      metadata.sessionId,
      {
        timestamp: new Date(),
        type: "session_start",
        sessionFormatVersion: SESSION_FORMAT_VERSION,
        ...metadata,
      },
      { dir: tmpDir },
    );

    // when:
    const exists = await sessionFileExists(metadata.sessionId, { dir: tmpDir });

    // then:
    assert.equal(exists, true);
  });
});

describe("persistSessionEvent + loadSession", () => {
  it("replays messages, resets, usage, and subagent transitions", async () => {
    // given:
    await persistSessionEvent(
      metadata.sessionId,
      {
        timestamp: new Date(),
        type: "session_start",
        sessionFormatVersion: SESSION_FORMAT_VERSION,
        ...metadata,
      },
      { dir: tmpDir },
    );
    await persistSessionEvent(
      metadata.sessionId,
      { timestamp: new Date(), type: "message", message: systemMessage },
      { dir: tmpDir },
    );
    await persistSessionEvent(
      metadata.sessionId,
      { timestamp: new Date(), type: "message", message: userMessage },
      { dir: tmpDir },
    );
    await persistSessionEvent(
      metadata.sessionId,
      {
        timestamp: new Date(),
        type: "messages_reset",
        messages: [systemMessage],
      },
      { dir: tmpDir },
    );
    const subagent = {
      name: "researcher",
      goal: "investigate",
      switchMessageIndex: 1,
    };
    await persistSessionEvent(
      metadata.sessionId,
      { timestamp: new Date(), type: "subagent_switched", subagent },
      { dir: tmpDir },
    );
    await persistSessionEvent(
      metadata.sessionId,
      { timestamp: new Date(), type: "subagent_switched", subagent: null },
      { dir: tmpDir },
    );
    await persistSessionEvent(
      metadata.sessionId,
      { timestamp: new Date(), type: "subagent_switched", subagent },
      { dir: tmpDir },
    );
    await persistSessionEvent(
      metadata.sessionId,
      { timestamp: new Date(), type: "token_usage", usage: { inputTokens: 4 } },
      { dir: tmpDir },
    );

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
    await persistSessionEvent(
      metadata.sessionId,
      {
        timestamp: new Date(),
        type: "session_start",
        sessionFormatVersion: SESSION_FORMAT_VERSION,
        ...metadata,
      },
      { dir: tmpDir },
    );
    await fs.appendFile(
      sessionFilePath(metadata.sessionId, { dir: tmpDir }),
      "not json\n",
      "utf8",
    );
    await persistSessionEvent(
      metadata.sessionId,
      {
        timestamp: new Date(),
        type: "session_start",
        sessionFormatVersion: 999,
        ...metadata,
      },
      { dir: tmpDir },
    );
    await persistSessionEvent(
      metadata.sessionId,
      { timestamp: new Date(), type: "message", message: userMessage },
      { dir: tmpDir },
    );

    // when:
    const loaded = await loadSession(metadata.sessionId, { dir: tmpDir });

    // then:
    assert.deepEqual(loaded?.messages, [userMessage]);
  });

  it("does not create a stream for an event outside the session format", async () => {
    // when:
    await persistSessionEvent(
      "not-persisted",
      { timestamp: new Date(), type: "turn_end" },
      { dir: tmpDir },
    );
    const loaded = await loadSession("not-persisted", { dir: tmpDir });

    // then:
    assert.equal(loaded, null);
  });

  it("returns null for a missing stream", async () => {
    // when:
    const loaded = await loadSession("missing", { dir: tmpDir });
    // then:
    assert.equal(loaded, null);
  });

  it("throws for a format-version mismatch", async () => {
    // given:
    await persistSessionEvent(
      metadata.sessionId,
      {
        timestamp: new Date(),
        type: "session_start",
        sessionFormatVersion: 999,
        ...metadata,
      },
      { dir: tmpDir },
    );
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
    await persistSessionEvent(
      "older",
      {
        timestamp: new Date(),
        type: "session_start",
        sessionFormatVersion: SESSION_FORMAT_VERSION,
        ...metadata,
        sessionId: "older",
      },
      { dir: tmpDir },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await persistSessionEvent(
      "newer",
      {
        timestamp: new Date(),
        type: "session_start",
        sessionFormatVersion: SESSION_FORMAT_VERSION,
        ...metadata,
        sessionId: "newer",
      },
      { dir: tmpDir },
    );
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
