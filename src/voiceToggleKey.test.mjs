import assert from "node:assert";
import { describe, it } from "node:test";
import { parseVoiceToggleKey } from "./voiceToggleKey.mjs";

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
