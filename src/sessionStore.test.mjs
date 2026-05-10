import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  listSessions,
  loadSession,
  SESSION_FILE_VERSION,
  saveSession,
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

/**
 * @param {Partial<import("./sessionStore.mjs").SessionState>} overrides
 * @returns {import("./sessionStore.mjs").SessionState}
 */
function buildState(overrides = {}) {
  return {
    version: SESSION_FILE_VERSION,
    sessionId: "2026-05-10-0803",
    modelName: "claude-sonnet-4-6+thinking-high",
    workingDir: "/w",
    startTime: "2026-05-10T08:03:00.000Z",
    lastUpdatedAt: "2026-05-10T08:03:00.000Z",
    messages: [{ role: "system", content: [{ type: "text", text: "system" }] }],
    subagentState: { subagents: [], subagentCount: 0 },
    allowedToolUseInSession: [],
    tokenUsageHistory: [],
    ...overrides,
  };
}

describe("sessionFilePath", () => {
  it("joins directory and sessionId.json", () => {
    // when:
    const result = sessionFilePath("abc", { dir: "/tmp/sessions" });
    // then:
    assert.equal(result, path.join("/tmp/sessions", "abc.json"));
  });
});

describe("saveSession + loadSession", () => {
  it("round-trips a session state", async () => {
    // given:
    const state = buildState();

    // when:
    await saveSession(state, { dir: tmpDir });
    const loaded = await loadSession(state.sessionId, { dir: tmpDir });

    // then:
    assert.deepStrictEqual(loaded, state);
  });

  it("creates the directory when missing", async () => {
    // given:
    const nested = path.join(tmpDir, "nested", "sessions");
    const state = buildState();

    // when:
    await saveSession(state, { dir: nested });

    // then:
    const stat = await fs.stat(path.join(nested, `${state.sessionId}.json`));
    assert.ok(stat.isFile());
  });

  it("overwrites an existing file atomically", async () => {
    // given:
    const state1 = buildState({ lastUpdatedAt: "2026-05-10T08:03:00.000Z" });
    const state2 = buildState({ lastUpdatedAt: "2026-05-10T09:00:00.000Z" });

    // when:
    await saveSession(state1, { dir: tmpDir });
    await saveSession(state2, { dir: tmpDir });

    // then:
    const loaded = await loadSession(state1.sessionId, { dir: tmpDir });
    assert.equal(loaded?.lastUpdatedAt, "2026-05-10T09:00:00.000Z");
    // No leftover temp file
    const entries = await fs.readdir(tmpDir);
    assert.deepEqual(
      entries.filter((e) => e.includes(".tmp.")),
      [],
    );
  });

  it("returns null when the session file does not exist", async () => {
    // when:
    const loaded = await loadSession("nonexistent", { dir: tmpDir });

    // then:
    assert.equal(loaded, null);
  });

  it("throws on unsupported version", async () => {
    // given:
    const target = path.join(tmpDir, "bad.json");
    await fs.writeFile(
      target,
      JSON.stringify({ version: 999, sessionId: "bad" }),
      "utf8",
    );

    // when/then:
    await assert.rejects(
      () => loadSession("bad", { dir: tmpDir }),
      /Unsupported session file version/,
    );
  });

  it("throws on a non-object payload", async () => {
    // given:
    const target = path.join(tmpDir, "junk.json");
    await fs.writeFile(target, JSON.stringify(42), "utf8");

    // when/then:
    await assert.rejects(
      () => loadSession("junk", { dir: tmpDir }),
      /Invalid session file/,
    );
  });
});

describe("listSessions", () => {
  it("returns an empty list when the directory is missing", async () => {
    // when:
    const sessions = await listSessions({
      dir: path.join(tmpDir, "missing"),
    });

    // then:
    assert.deepEqual(sessions, []);
  });

  it("lists sessions sorted by lastUpdatedAt descending", async () => {
    // given:
    await saveSession(
      buildState({
        sessionId: "older",
        lastUpdatedAt: "2026-05-10T08:00:00.000Z",
      }),
      { dir: tmpDir },
    );
    await saveSession(
      buildState({
        sessionId: "newer",
        lastUpdatedAt: "2026-05-10T09:00:00.000Z",
      }),
      { dir: tmpDir },
    );

    // when:
    const sessions = await listSessions({ dir: tmpDir });

    // then:
    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      ["newer", "older"],
    );
  });

  it("skips temp files and malformed entries", async () => {
    // given:
    await saveSession(buildState({ sessionId: "good" }), { dir: tmpDir });
    await fs.writeFile(path.join(tmpDir, "good.json.tmp.123"), "garbage");
    await fs.writeFile(path.join(tmpDir, "bad.json"), "not json");
    await fs.writeFile(
      path.join(tmpDir, "wrong-version.json"),
      JSON.stringify({ version: 999 }),
    );

    // when:
    const sessions = await listSessions({ dir: tmpDir });

    // then:
    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      ["good"],
    );
  });
});
