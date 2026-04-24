import assert from "node:assert";
import { describe, it } from "node:test";
import {
  createCJKSpaceNormalizer,
  detectRecorder,
  getRecorderCandidates,
} from "./voiceInputSession.mjs";

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
    const candidates = getRecorderCandidates(16000);
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
    const candidates = getRecorderCandidates(16000);
    assert.strictEqual(candidates[0].command, "arecord");
  });

  it("does not include arecord on macOS", () => {
    if (process.platform !== "darwin") {
      return;
    }
    const candidates = getRecorderCandidates(16000);
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
