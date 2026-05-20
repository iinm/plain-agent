import assert from "node:assert";
import { describe, it } from "node:test";
import { createWebSearchTool, truncateText } from "./webSearch.mjs";

/**
 * @returns {import("./webSearch.mjs").WebSearchToolCommandOptions}
 */
function newCommandConfig() {
  return {
    provider: "command",
    command: "true",
    args: [],
    modelCaller: async () => ({
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    }),
  };
}

describe("createWebSearchTool input validation", () => {
  it("rejects input that is missing searches", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({ question: "What is this?" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`searches` is required/);
  });

  it("rejects an empty searches array", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({ searches: [], question: "q" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`searches` is required/);
  });

  it("rejects a search entry that is not an object", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({
      searches: [["foo"]],
      question: "q",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /must be an object/);
  });

  it("rejects a search whose keywords array is empty", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({
      searches: [{ keywords: [] }],
      question: "q",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /non-empty array of non-empty strings/);
  });

  it("rejects a search keyword that is not a non-empty string", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({
      searches: [{ keywords: ["ok", ""] }],
      question: "q",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /non-empty array of non-empty strings/);
  });

  it("rejects input that is missing a question", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({ searches: [{ keywords: ["foo"] }] });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`question` is required/);
  });
});

describe("webSearchViaCommand delay between requests", () => {
  it("completes multiple searches without error using default delay", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({
      searches: [{ keywords: ["a"] }, { keywords: ["b"] }],
      question: "test",
    });

    // then:
    assert.ok(
      !(result instanceof Error),
      result instanceof Error ? result.message : undefined,
    );
  });

  it("completes with zero delay (no delay between searches)", async () => {
    // given:
    const config = { ...newCommandConfig(), delayBetweenRequestsMs: 0 };
    const tool = createWebSearchTool(config);

    // when:
    const result = await tool.impl({
      searches: [{ keywords: ["a"] }, { keywords: ["b"] }, { keywords: ["c"] }],
      question: "test",
    });

    // then:
    assert.ok(
      !(result instanceof Error),
      result instanceof Error ? result.message : undefined,
    );
  });

  it("respects a custom delay between searches", async () => {
    // given:
    const customDelayMs = 50;
    const config = {
      ...newCommandConfig(),
      delayBetweenRequestsMs: customDelayMs,
    };
    const tool = createWebSearchTool(config);

    // when:
    const start = performance.now();
    const result = await tool.impl({
      searches: [{ keywords: ["a"] }, { keywords: ["b"] }, { keywords: ["c"] }],
      question: "test",
    });
    const elapsed = performance.now() - start;

    // then:
    assert.ok(
      !(result instanceof Error),
      result instanceof Error ? result.message : undefined,
    );
    // 2 delays between 3 searches: 2 * 50ms = 100ms minimum
    assert.ok(
      elapsed >= 2 * customDelayMs - 50,
      `Expected at least ${2 * customDelayMs}ms elapsed, but got ${elapsed}ms`,
    );
  });
});

describe("truncateText", () => {
  it("returns the original content when it is within the length budget", () => {
    // given:
    const content = "hello";

    // when:
    const result = truncateText(content, 10);

    // then:
    assert.equal(result.text, "hello");
    assert.equal(result.truncated, false);
    assert.equal(result.originalLength, 5);
  });

  it("truncates content and appends a marker", () => {
    // given:
    const content = "abcdefghij";

    // when:
    const result = truncateText(content, 4);

    // then:
    assert.equal(result.truncated, true);
    assert.equal(result.originalLength, 10);
    assert.ok(result.text.startsWith("abcd"));
    assert.ok(result.text.includes("[truncated: 6 of 10 chars omitted]"));
  });
});
