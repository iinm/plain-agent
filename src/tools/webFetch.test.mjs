import assert from "node:assert";
import { describe, it } from "node:test";
import {
  createWebFetchTool,
  extractOrigin,
  isUrlAllowed,
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

describe("isUrlAllowed", () => {
  it("allows every URL when no allow list is configured", () => {
    // given/when/then:
    assert.equal(isUrlAllowed("https://any.example.org/x", undefined), true);
  });

  it("denies every URL when the allow list is empty", () => {
    // given/when/then:
    assert.equal(isUrlAllowed("https://example.com", []), false);
  });

  it("matches an exact host and any subdomain", () => {
    // given:
    const allowedDomains = ["example.com"];

    // when/then:
    assert.equal(isUrlAllowed("https://example.com/a", allowedDomains), true);
    assert.equal(isUrlAllowed("https://a.b.example.com", allowedDomains), true);
  });

  it("supports wildcard entries that exclude the apex domain", () => {
    // given:
    const allowedDomains = ["*.example.com"];

    // when/then:
    assert.equal(isUrlAllowed("https://a.example.com", allowedDomains), true);
    assert.equal(isUrlAllowed("https://example.com", allowedDomains), false);
  });

  it("does not match lookalike hosts", () => {
    // given:
    const allowedDomains = ["example.com"];

    // when/then:
    assert.equal(
      isUrlAllowed("https://evil-example.com", allowedDomains),
      false,
    );
  });

  it("ignores case, scheme, port, path, and query", () => {
    // given/when/then:
    assert.equal(
      isUrlAllowed("http://EXAMPLE.com:8080/p?q=1", ["example.com"]),
      true,
    );
  });

  it("denies non-http(s) or malformed URLs when a list is configured", () => {
    // given/when/then:
    assert.equal(isUrlAllowed("file:///etc/passwd", ["example.com"]), false);
    assert.equal(isUrlAllowed("not a url", ["example.com"]), false);
  });
});

describe("createWebFetchTool#allowedDomains", () => {
  it("blocks a fetch to a host outside the allow list without calling the provider", async () => {
    // given:
    let modelCallerCalled = false;
    const tool = createWebFetchTool({
      provider: "command",
      command: "true",
      args: [],
      allowedDomains: ["example.com"],
      modelCaller: async () => {
        modelCallerCalled = true;
        return {
          message: { role: "assistant", content: [{ type: "text", text: "" }] },
        };
      },
    });

    // when:
    const result = await tool.impl({ url: "https://other.com", question: "?" });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Blocked by allowedDomains/);
    assert.equal(modelCallerCalled, false);
  });

  it("exposes validateInput that rejects blocked URLs", () => {
    // given:
    const tool = createWebFetchTool({
      provider: "command",
      command: "true",
      args: [],
      allowedDomains: [],
      modelCaller: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      }),
    });

    // when:
    const error = tool.validateInput?.({
      url: "https://example.com",
      question: "?",
    });

    // then:
    assert.ok(error instanceof Error);
    assert.match(error.message, /Blocked by allowedDomains/);
  });

  it("allows a fetch to a listed host", async () => {
    // given:
    const tool = createWebFetchTool({
      provider: "command",
      command: "true",
      args: [],
      allowedDomains: ["example.com"],
      modelCaller: async () => ({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      }),
    });

    // when:
    const result = await tool.impl({
      url: "https://example.com/x",
      question: "?",
    });

    // then:
    assert.equal(result, "ok\n\n- [1] https://example.com/x");
  });

  it("passes the canonical URL to the fetch command so the allowed host is the fetched host", async () => {
    // given: a URL whose authority Node's WHATWG `URL` and line-based fetchers
    // parse differently. `new URL` treats `\` in a special scheme as a path
    // separator (host `example.com`), while curl treats `\` as a normal
    // character and the `@` as the userinfo separator (host `evil.example`).
    // `isUrlAllowed` sees `example.com`, so the URL must not be handed to the
    // fetch command unchanged.
    const craftedUrl = "https://example.com\\@evil.example/";
    /** @type {string | undefined} */
    let contentSeenByModel;
    const tool = createWebFetchTool({
      provider: "command",
      // Echo back the URL argument the tool would fetch.
      command: process.execPath,
      args: ["-e", "console.log(process.argv[1])"],
      allowedDomains: ["example.com"],
      modelCaller: async (request) => {
        const lastMessage = request.messages.at(-1);
        contentSeenByModel = lastMessage?.content
          .map((part) => ("text" in part ? part.text : ""))
          .join("");
        return {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          },
        };
      },
    });

    // when:
    const result = await tool.impl({ url: craftedUrl, question: "?" });

    // then: the command (and the prompt) must see the canonical URL, so the
    // validated host and the fetched host agree.
    assert.ok(!(result instanceof Error), String(result));
    assert.ok(
      !contentSeenByModel?.includes(craftedUrl),
      "the raw crafted URL reached the fetch command",
    );
    assert.ok(
      contentSeenByModel?.includes("https://example.com/@evil.example/"),
      "expected the canonical URL to reach the fetch command",
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
