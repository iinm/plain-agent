import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractInputTokenCount } from "./agentLoop.mjs";

describe("extractInputTokenCount", () => {
  it("returns the value of a single specified key", () => {
    // given:
    const usage = { promptTokenCount: 60000, candidatesTokenCount: 3000 };

    // when:
    const result = extractInputTokenCount(usage, ["promptTokenCount"]);

    // then:
    assert.strictEqual(result, 60000);
  });

  it("sums multiple specified keys", () => {
    // given:
    const usage = { input_tokens: 50000, cache_read_input_tokens: 10000 };

    // when:
    const result = extractInputTokenCount(usage, [
      "input_tokens",
      "cache_read_input_tokens",
    ]);

    // then:
    assert.strictEqual(result, 60000);
  });

  it("skips missing keys when summing", () => {
    // given:
    const usage = { input_tokens: 50000, output_tokens: 1000 };

    // when:
    const result = extractInputTokenCount(usage, [
      "input_tokens",
      "cache_read_input_tokens",
    ]);

    // then:
    assert.strictEqual(result, 50000);
  });

  it("ignores zero values", () => {
    // given:
    const usage = { input_tokens: 0, cache_read_input_tokens: 45000 };

    // when:
    const result = extractInputTokenCount(usage, [
      "input_tokens",
      "cache_read_input_tokens",
    ]);

    // then:
    assert.strictEqual(result, 45000);
  });

  it("returns undefined when no specified key exists", () => {
    // given:
    const usage = { some_other_key: 42 };

    // when:
    const result = extractInputTokenCount(usage, ["input_tokens"]);

    // then:
    assert.strictEqual(result, undefined);
  });
});
