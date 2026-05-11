import assert from "node:assert";
import { describe, it } from "node:test";
import { createWebFetchTool, truncateText } from "./webFetch.mjs";

describe("createWebFetchTool", () => {
  it("rejects input that is missing a URL", async () => {
    // given:
    const tool = createWebFetchTool({
      provider: "command",
      command: "true",
      args: [],
      modelCaller: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      }),
    });

    // when:
    const result = await tool.impl({ question: "What is this?" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /`url` is required/);
  });

  it("rejects a URL that does not start with http(s)://", async () => {
    // given:
    const tool = createWebFetchTool({
      provider: "command",
      command: "true",
      args: [],
      modelCaller: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      }),
    });

    // when:
    const result = await tool.impl({
      url: "ftp://example.com/file",
      question: "What is this?",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /must start with http\(s\):\/\//);
  });

  it("rejects input that is missing a question", async () => {
    // given:
    const tool = createWebFetchTool({
      provider: "command",
      command: "true",
      args: [],
      modelCaller: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      }),
    });

    // when:
    const result = await tool.impl({ url: "https://example.com" });

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
