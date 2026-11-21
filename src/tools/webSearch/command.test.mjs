import assert from "node:assert";
import { describe, it } from "node:test";
import { createWebSearchTool } from "../webSearch.mjs";

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

describe("webSearchViaCommand failures", () => {
  it("reports every failed search when none succeed", async () => {
    // given:
    const tool = createWebSearchTool({
      ...newCommandConfig(),
      command: "false",
    });

    // when:
    const result = await tool.impl({
      searches: [{ keywords: ["alpha"] }, { keywords: ["beta"] }],
      question: "q",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Failed to run any search via false:/);
    assert.match(result.message, /- \[alpha\]:/);
    assert.match(result.message, /- \[beta\]:/);
  });
});

describe("webSearchViaCommand truncation", () => {
  it("derives sources from the truncated text only", async () => {
    // given:
    /** @type {import("../../model").ModelInput[]} */
    const modelInputs = [];
    /** @type {import("./command.mjs").WebSearchToolCommandOptions} */
    const config = {
      ...newCommandConfig(),
      command: "echo",
      args: [`https://example.com/a ${"x".repeat(200)} https://example.com/b`],
      maxLengthPerSearch: 40,
      modelCaller: async (input) => {
        modelInputs.push(input);
        return {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Answer. [[1.1]] [[1.2]]" }],
          },
        };
      },
    };
    const tool = createWebSearchTool(config);

    // when:
    const result = await tool.impl({
      searches: [{ keywords: ["k"] }],
      question: "q",
    });

    // then:
    assert.ok(typeof result === "string", "expected a text result");
    assert.match(result, /\(truncated\)/);
    assert.match(result, /Sources:\n- \[1\.1\] https:\/\/example\.com\/a/);
    assert.doesNotMatch(result, /- \[1\.2\]/);

    const userMessage = modelInputs[0].messages[1];
    assert.ok(userMessage.role === "user");
    const userText = userMessage.content[0];
    assert.ok(userText.type === "text");
    assert.match(userText.text, /truncated="true" original_length="\d+"/);
  });
});

/**
 * @returns {import("./command.mjs").WebSearchToolCommandOptions}
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
