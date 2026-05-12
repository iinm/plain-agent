import assert from "node:assert";
import { describe, it } from "node:test";
import {
  createWebFetchTool,
  extractOrigin,
  truncateText,
} from "./webFetch.mjs";

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

describe("createWebFetchTool#maskApprovalInput", () => {
  it("reduces the URL to its origin so any path under the same host re-uses the approval", () => {
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
    const masked = tool.maskApprovalInput?.({
      url: "https://example.com/some/path?query=1#frag",
      question: "What is this?",
    });

    // then:
    assert.deepStrictEqual(masked, { url: "https://example.com" });
  });

  it("returns an empty origin for non-http(s) URLs", () => {
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
    const masked = tool.maskApprovalInput?.({
      url: "file:///etc/passwd",
      question: "?",
    });

    // then:
    assert.deepStrictEqual(masked, { url: "" });
  });
});

describe("extractOrigin", () => {
  it("returns scheme + host for http(s) URLs", () => {
    // given/when/then:
    assert.equal(
      extractOrigin("https://example.com/path"),
      "https://example.com",
    );
    assert.equal(
      extractOrigin("http://example.com:8080/x"),
      "http://example.com:8080",
    );
  });

  it("returns empty string for non-http(s) or malformed URLs", () => {
    // given/when/then:
    assert.equal(extractOrigin("file:///x"), "");
    assert.equal(extractOrigin("not a url"), "");
    assert.equal(extractOrigin(undefined), "");
    assert.equal(extractOrigin(123), "");
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
