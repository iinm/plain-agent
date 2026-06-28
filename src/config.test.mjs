import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveContextSoftLimit } from "./config.mjs";

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
