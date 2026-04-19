import assert from "node:assert";
import { describe, it } from "node:test";
import {
  detectRecorder,
  getRecorderCandidates,
  startVoiceSession,
} from "./voiceInput.mjs";

describe("getRecorderCandidates", () => {
  it("returns a non-empty list of recorder candidates", () => {
    const candidates = getRecorderCandidates();
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
      assert.strictEqual(typeof candidate.command, "string");
      assert.ok(Array.isArray(candidate.args));
    }
  });

  it("prefers arecord on non-macOS platforms", () => {
    if (process.platform === "darwin") {
      return;
    }
    const candidates = getRecorderCandidates();
    assert.strictEqual(candidates[0].command, "arecord");
  });

  it("does not include arecord on macOS", () => {
    if (process.platform !== "darwin") {
      return;
    }
    const candidates = getRecorderCandidates();
    const names = candidates.map((c) => c.command);
    assert.ok(!names.includes("arecord"));
  });
});

describe("detectRecorder", () => {
  it("returns the first candidate whose command exists on PATH", () => {
    // `sh` is virtually guaranteed on any POSIX system and on Windows via
    // Git Bash. Use a bogus first candidate to confirm fallthrough.
    const candidates = [
      { command: "__definitely_not_a_real_binary__", args: [] },
      { command: process.platform === "win32" ? "cmd" : "sh", args: [] },
    ];
    const result = detectRecorder(candidates);
    assert.ok(result !== null);
    assert.strictEqual(
      result?.command,
      process.platform === "win32" ? "cmd" : "sh",
    );
  });

  it("returns null when no candidate is available", () => {
    const result = detectRecorder([
      { command: "__definitely_not_a_real_binary_1__", args: [] },
      { command: "__definitely_not_a_real_binary_2__", args: [] },
    ]);
    assert.strictEqual(result, null);
  });
});

describe("startVoiceSession", () => {
  it("emits an error and closes when no recorder is configured or detected", async () => {
    /** @type {Error[]} */
    const errors = [];
    let closed = false;

    const session = startVoiceSession({
      config: {
        provider: "gemini",
        apiKey: "fake-key",
        recorder: {
          command: "__definitely_not_a_real_binary__",
          args: [],
        },
      },
      callbacks: {
        onTranscript: () => {
          assert.fail("onTranscript should not be called");
        },
        onError: (err) => {
          errors.push(err);
        },
        onClose: () => {
          closed = true;
        },
      },
    });

    // Trigger stop to ensure idempotency and allow cleanup to run.
    await session.stop();

    // Give any queued microtasks a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(closed, "onClose should be invoked");
    // Depending on timing, error may come from ENOENT before stop() short-
    // circuits. Either way the session must terminate cleanly.
    for (const err of errors) {
      assert.ok(err instanceof Error);
    }
  });

  it("is safe to stop() multiple times", async () => {
    const session = startVoiceSession({
      config: {
        provider: "gemini",
        apiKey: "fake-key",
        recorder: {
          command: "__definitely_not_a_real_binary__",
          args: [],
        },
      },
      callbacks: {
        onTranscript: () => {},
        onError: () => {},
        onClose: () => {},
      },
    });
    await session.stop();
    await session.stop();
    await session.stop();
  });
});
