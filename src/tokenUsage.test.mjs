import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractInputTokenCount } from "./tokenUsage.mjs";

describe("extractInputTokenCount", () => {
  it("extracts input_tokens for Anthropic", () => {
    // given:
    const usage = {
      input_tokens: 50000,
      output_tokens: 1000,
      cache_read_input_tokens: 10000,
    };
    const keys = ["input_tokens", "cache_read_input_tokens"];

    // when:
    const result = extractInputTokenCount(usage, keys);

    // then:
    assert.strictEqual(result, 60000);
  });

  it("extracts inputTokens + cacheReadInputTokens for Bedrock", () => {
    // given:
    const usage = {
      inputTokens: 80000,
      outputTokens: 2000,
      cacheReadInputTokens: 5000,
    };
    const keys = ["inputTokens", "cacheReadInputTokens"];

    // when:
    const result = extractInputTokenCount(usage, keys);

    // then:
    assert.strictEqual(result, 85000);
  });

  it("extracts promptTokenCount for Gemini", () => {
    // given:
    const usage = { promptTokenCount: 60000, candidatesTokenCount: 3000 };
    const keys = ["promptTokenCount"];

    // when:
    const result = extractInputTokenCount(usage, keys);

    // then:
    assert.strictEqual(result, 60000);
  });

  it("extracts input_tokens for OpenAI", () => {
    // given:
    const usage = {
      input_tokens: 70000,
      output_tokens: 1500,
      total_tokens: 71500,
    };
    const keys = ["input_tokens"];

    // when:
    const result = extractInputTokenCount(usage, keys);

    // then:
    assert.strictEqual(result, 70000);
  });

  it("extracts prompt_tokens for OpenAI Compatible", () => {
    // given:
    const usage = { prompt_tokens: 55000, completion_tokens: 2000 };
    const keys = ["prompt_tokens"];

    // when:
    const result = extractInputTokenCount(usage, keys);

    // then:
    assert.strictEqual(result, 55000);
  });

  it("returns undefined when no specified key exists", () => {
    // given:
    const usage = { some_other_key: 42 };
    const keys = ["input_tokens"];

    // when:
    const result = extractInputTokenCount(usage, keys);

    // then:
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for empty object", () => {
    // given:
    /** @type {Record<string, number>} */
    const usage = {};
    const keys = ["input_tokens"];

    // when:
    const result = extractInputTokenCount(usage, keys);

    // then:
    assert.strictEqual(result, undefined);
  });

  it("ignores zero values in summed keys", () => {
    // given:
    const usage = { input_tokens: 0, cache_read_input_tokens: 45000 };
    const keys = ["input_tokens", "cache_read_input_tokens"];

    // when:
    const result = extractInputTokenCount(usage, keys);

    // then:
    assert.strictEqual(result, 45000);
  });

  it("skips missing optional keys in sum", () => {
    // given:
    const usage = { input_tokens: 50000, output_tokens: 1000 };
    const keys = ["input_tokens", "cache_read_input_tokens"];

    // when:
    const result = extractInputTokenCount(usage, keys);

    // then:
    assert.strictEqual(result, 50000);
  });
});
