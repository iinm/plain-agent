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
  it("rejects input that is missing keywords", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({ question: "What is this?" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`keywords` is required/);
  });

  it("rejects an empty keywords array", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({ keywords: [], question: "q" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`keywords` is required/);
  });

  it("rejects a keyword set that is empty", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({ keywords: [[]], question: "q" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /non-empty array of non-empty strings/);
  });

  it("rejects a keyword that is not a string", async () => {
    // given:
    const tool = createWebSearchTool(newCommandConfig());

    // when:
    const result = await tool.impl({
      keywords: [["ok", ""]],
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
    const result = await tool.impl({ keywords: [["foo"]] });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`question` is required/);
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
