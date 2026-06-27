import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractInputTokenCount } from "./tokenUsage.mjs";

describe("extractInputTokenCount", () => {
  it("extracts input_tokens (Anthropic/OpenAI)", () => {
    // given:
    const usage = { input_tokens: 50000, output_tokens: 1000 };

    // when:
    const result = extractInputTokenCount(usage);

    // then:
    assert.strictEqual(result, 50000);
  });

  it("extracts inputTokens (Bedrock)", () => {
    // given:
    const usage = { inputTokens: 80000, outputTokens: 2000 };

    // when:
    const result = extractInputTokenCount(usage);

    // then:
    assert.strictEqual(result, 80000);
  });

  it("extracts promptTokenCount (Gemini)", () => {
    // given:
    const usage = { promptTokenCount: 60000, candidatesTokenCount: 3000 };

    // when:
    const result = extractInputTokenCount(usage);

    // then:
    assert.strictEqual(result, 60000);
  });

  it("extracts from nested usage object (e.g., bedrock usage sub-object)", () => {
    // given:
    const usage = {
      usage: { inputTokens: 70000, outputTokens: 1500 },
    };

    // when:
    const result = extractInputTokenCount(usage);

    // then:
    assert.strictEqual(result, 70000);
  });

  it("returns undefined when no recognizable key exists", () => {
    // given:
    const usage = { some_other_key: 42 };

    // when:
    const result = extractInputTokenCount(usage);

    // then:
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for empty object", () => {
    // given:
    /** @type {Record<string, number>} */
    const usage = {};

    // when:
    const result = extractInputTokenCount(usage);

    // then:
    assert.strictEqual(result, undefined);
  });

  it("ignores zero values", () => {
    // given:
    const usage = { input_tokens: 0, promptTokenCount: 45000 };

    // when:
    const result = extractInputTokenCount(usage);

    // then:
    assert.strictEqual(result, 45000);
  });

  it("prioritizes input_tokens over other keys", () => {
    // given:
    const usage = { input_tokens: 100000, promptTokenCount: 99000 };

    // when:
    const result = extractInputTokenCount(usage);

    // then:
    assert.strictEqual(result, 100000);
  });
});
