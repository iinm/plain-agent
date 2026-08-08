import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAutoCompactMisconfigured,
  mergeAppConfig,
  resolveContextSoftLimit,
} from "./config.mjs";

describe("mergeAppConfig", () => {
  it("concatenates userPreferences across configs", () => {
    // given:
    const first = mergeAppConfig(
      {},
      { systemPrompt: { userPreferences: ["user A"] } },
      "a.json",
    );

    // when:
    const merged = mergeAppConfig(
      first,
      { systemPrompt: { userPreferences: ["cli B"] } },
      "b.json",
    );

    // then:
    assert.deepEqual(merged.systemPrompt, {
      userPreferences: ["cli B", "user A"],
    });
  });

  it("keeps userPreferences empty when no config defines them", () => {
    // given:
    const base = mergeAppConfig({}, {}, "a.json");

    // when:
    const result = mergeAppConfig(base, { systemPrompt: undefined }, "b.json");

    // then:
    assert.deepEqual(result.systemPrompt, { userPreferences: [] });
  });

  it("tags autoApproval patterns with their source and concats later files first", () => {
    // given:
    const first = mergeAppConfig(
      {},
      {
        autoApproval: {
          patterns: [{ toolName: "bash", action: "allow" }],
        },
      },
      "a.json",
    );

    // when:
    const merged = mergeAppConfig(
      first,
      {
        autoApproval: {
          patterns: [{ toolName: "bash", action: "allow" }],
        },
      },
      "b.json",
    );

    // then:
    assert.deepEqual(merged.autoApproval?.patterns, [
      { toolName: "bash", action: "allow", source: "b.json" },
      { toolName: "bash", action: "allow", source: "a.json" },
    ]);
  });

  it("lets the later file override earlier tool settings", () => {
    // given:
    const first = mergeAppConfig(
      {},
      {
        tools: {
          webSearch: { provider: "command", command: "x", args: ["x"] },
        },
      },
      "a.json",
    );

    // when:
    const merged = mergeAppConfig(
      first,
      {
        tools: {
          webSearch: {
            provider: "command",
            command: "y",
            args: ["y"],
            timeoutMs: 5,
          },
        },
      },
      "b.json",
    );

    // then:
    assert.deepEqual(merged.tools?.webSearch, {
      provider: "command",
      command: "y",
      args: ["y"],
      timeoutMs: 5,
    });
  });

  it("lets the later file override mcpServers with the same key", () => {
    // given:
    const first = mergeAppConfig(
      {},
      { mcpServers: { db: { command: "a" } } },
      "a.json",
    );

    // when:
    const merged = mergeAppConfig(
      first,
      { mcpServers: { db: { command: "b" } } },
      "b.json",
    );

    // then:
    assert.deepEqual(merged.mcpServers?.db, { command: "b" });
  });
});

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
  /** @type {Array<[string, number | undefined, string[] | undefined, boolean]>} */
  const cases = [
    ["softLimit set, inputTokensKeys undefined", 120000, undefined, true],
    ["softLimit set, inputTokensKeys empty", 120000, [], true],
    ["softLimit set, inputTokensKeys present", 120000, ["input_tokens"], false],
    ["softLimit undefined", undefined, undefined, false],
  ];
  for (const [desc, softLimit, keys, expected] of cases) {
    it(desc, () => {
      assert.strictEqual(isAutoCompactMisconfigured(softLimit, keys), expected);
    });
  }
});
