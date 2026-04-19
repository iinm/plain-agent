import assert from "node:assert";
import { describe, it } from "node:test";
import {
  createCJKSpaceNormalizer,
  detectRecorder,
  getRecorderCandidates,
  parseVoiceToggleKey,
  startVoiceSession,
} from "./voiceInput.mjs";

describe("parseVoiceToggleKey", () => {
  it("defaults to Ctrl-O when spec is undefined", () => {
    const key = parseVoiceToggleKey(undefined);
    assert.strictEqual(key.byte, 0x0f);
    assert.strictEqual(key.label, "Ctrl-O");
  });

  it("parses ctrl-<letter> case-insensitively", () => {
    assert.strictEqual(parseVoiceToggleKey("ctrl-o").byte, 0x0f);
    assert.strictEqual(parseVoiceToggleKey("CTRL-O").byte, 0x0f);
    assert.strictEqual(parseVoiceToggleKey("  Ctrl-O  ").byte, 0x0f);
    assert.strictEqual(parseVoiceToggleKey("ctrl-a").byte, 0x01);
    assert.strictEqual(parseVoiceToggleKey("ctrl-z").byte, 0x1a);
  });

  it("parses ctrl-<symbol> for [ \\ ] ^ _", () => {
    assert.strictEqual(parseVoiceToggleKey("ctrl-[").byte, 0x1b);
    assert.strictEqual(parseVoiceToggleKey("ctrl-\\").byte, 0x1c);
    assert.strictEqual(parseVoiceToggleKey("ctrl-]").byte, 0x1d);
    assert.strictEqual(parseVoiceToggleKey("ctrl-^").byte, 0x1e);
    assert.strictEqual(parseVoiceToggleKey("ctrl-_").byte, 0x1f);
  });

  it("rejects malformed specs", () => {
    assert.throws(() => parseVoiceToggleKey("g"));
    assert.throws(() => parseVoiceToggleKey("alt-g"));
    assert.throws(() => parseVoiceToggleKey("ctrl-shift-g"));
    assert.throws(() => parseVoiceToggleKey(""));
  });

  it("rejects keys that conflict with reserved terminal bytes", () => {
    assert.throws(() => parseVoiceToggleKey("ctrl-c"));
    assert.throws(() => parseVoiceToggleKey("ctrl-d"));
    assert.throws(() => parseVoiceToggleKey("ctrl-i")); // Tab
    assert.throws(() => parseVoiceToggleKey("ctrl-j")); // LF
    assert.throws(() => parseVoiceToggleKey("ctrl-m")); // CR
    assert.throws(() => parseVoiceToggleKey("ctrl-q")); // XON
    assert.throws(() => parseVoiceToggleKey("ctrl-s")); // XOFF
  });
});

describe("createCJKSpaceNormalizer", () => {
  it("drops whitespace sitting between two CJK characters", () => {
    const n = createCJKSpaceNormalizer();
    assert.strictEqual(
      n.push("そう 、 声 で 入力 できる よう に なっ た の 。"),
      "そう、声で入力できるようになったの。",
    );
  });

  it("keeps whitespace when either side is not CJK", () => {
    const n = createCJKSpaceNormalizer();
    assert.strictEqual(n.push("Hello world"), "Hello world");
  });

  it("keeps space between Latin and CJK in mixed text", () => {
    const n = createCJKSpaceNormalizer();
    assert.strictEqual(n.push("Windows を 使う"), "Windows を使う");
  });

  it("handles whitespace split across delta boundaries", () => {
    const n = createCJKSpaceNormalizer();
    // Trailing space on the first delta is held until the next delta's
    // leading character decides whether to keep or drop it.
    assert.strictEqual(n.push("そう "), "そう");
    assert.strictEqual(n.push("、声"), "、声");
  });

  it("keeps a held space when the next delta starts with Latin", () => {
    const n = createCJKSpaceNormalizer();
    assert.strictEqual(n.push("これ "), "これ");
    assert.strictEqual(n.push("test"), " test");
  });

  it("treats fullwidth punctuation and kana as CJK", () => {
    const n = createCJKSpaceNormalizer();
    assert.strictEqual(n.push("カタカナ 、 テスト"), "カタカナ、テスト");
  });

  it("flush() returns any whitespace that was still pending", () => {
    const n = createCJKSpaceNormalizer();
    assert.strictEqual(n.push("ほげ "), "ほげ");
    assert.strictEqual(n.flush(), " ");
  });
});

describe("getRecorderCandidates", () => {
  it("returns a non-empty list of recorder candidates", () => {
    const candidates = getRecorderCandidates();
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
      assert.strictEqual(typeof candidate.command, "string");
      assert.ok(Array.isArray(candidate.args));
    }
  });

  it("uses the given sample rate in the recorder args", () => {
    const candidates = getRecorderCandidates(24000);
    for (const candidate of candidates) {
      assert.ok(
        candidate.args.includes("24000"),
        `${candidate.command} args should include 24000: ${JSON.stringify(candidate.args)}`,
      );
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

  it("rejects unsupported providers", async () => {
    /** @type {Error[]} */
    const errors = [];
    let closed = false;
    const session = startVoiceSession({
      config: /** @type {never} */ ({
        provider: "bogus",
        apiKey: "fake-key",
      }),
      callbacks: {
        onTranscript: () => {},
        onError: (err) => {
          errors.push(err);
        },
        onClose: () => {
          closed = true;
        },
      },
    });
    await session.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(closed);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Unsupported voiceInput\.provider/);
  });

  it("accepts an openai config without throwing synchronously", async () => {
    const session = startVoiceSession({
      config: {
        provider: "openai",
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
  });
});
