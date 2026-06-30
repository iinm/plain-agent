import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAutoCompactMisconfigured,
  resolveContextSoftLimit,
} from "./config.mjs";

describe("resolveContextSoftLimit", () => {
  it("returns softLimit when no prefix matches", () => {
    // given:
    const autoCompact = { softLimit: 120000 };

    // when:
    const result = resolveContextSoftLimit(
      autoCompact,
      "claude-sonnet-4-6+thinking-high",
    );

    // then:
    assert.strictEqual(result, 120000);
  });

  it("returns prefix match over softLimit", () => {
    // given:
    const autoCompact = {
      softLimit: 120000,
      softLimitPerModelPrefix: { "gemini-2.5-pro": 500000 },
    };

    // when:
    const result = resolveContextSoftLimit(
      autoCompact,
      "gemini-2.5-pro+thinking",
    );

    // then:
    assert.strictEqual(result, 500000);
  });

  it("falls back to softLimit when prefix does not match", () => {
    // given:
    const autoCompact = {
      softLimit: 120000,
      softLimitPerModelPrefix: { "gemini-2.5-pro": 500000 },
    };

    // when:
    const result = resolveContextSoftLimit(
      autoCompact,
      "claude-sonnet-4-6+default",
    );

    // then:
    assert.strictEqual(result, 120000);
  });

  it("returns undefined when autoCompact is undefined", () => {
    // given:
    const autoCompact = undefined;

    // when:
    const result = resolveContextSoftLimit(autoCompact, "claude-sonnet-4-6");

    // then:
    assert.strictEqual(result, undefined);
  });

  it("returns undefined when neither softLimit nor prefix is set", () => {
    // given:
    const autoCompact = {};

    // when:
    const result = resolveContextSoftLimit(autoCompact, "claude-sonnet-4-6");

    // then:
    assert.strictEqual(result, undefined);
  });
});

describe("isAutoCompactMisconfigured", () => {
  it("returns true when softLimit is set but inputTokensKeys is undefined", () => {
    // given:
    const contextSoftLimit = 120000;
    const inputTokensKeys = undefined;

    // when:
    const result = isAutoCompactMisconfigured(
      contextSoftLimit,
      inputTokensKeys,
    );

    // then:
    assert.strictEqual(result, true);
  });

  it("returns true when softLimit is set but inputTokensKeys is empty", () => {
    // given:
    const contextSoftLimit = 120000;
    /** @type {string[]} */
    const inputTokensKeys = [];

    // when:
    const result = isAutoCompactMisconfigured(
      contextSoftLimit,
      inputTokensKeys,
    );

    // then:
    assert.strictEqual(result, true);
  });

  it("returns false when softLimit is set and inputTokensKeys has values", () => {
    // given:
    const contextSoftLimit = 120000;
    const inputTokensKeys = ["input_tokens", "cache_read_input_tokens"];

    // when:
    const result = isAutoCompactMisconfigured(
      contextSoftLimit,
      inputTokensKeys,
    );

    // then:
    assert.strictEqual(result, false);
  });

  it("returns false when softLimit is undefined", () => {
    // given:
    const contextSoftLimit = undefined;
    const inputTokensKeys = undefined;

    // when:
    const result = isAutoCompactMisconfigured(
      contextSoftLimit,
      inputTokensKeys,
    );

    // then:
    assert.strictEqual(result, false);
  });
});
