import assert from "node:assert";
import { describe, it } from "node:test";
import { createWebFetchTool, truncateText } from "./webFetch.mjs";

/**
 * @param {string} url
 * @param {string[] | undefined} allowedDomains
 * @returns {Error | undefined}
 */
function validateUrl(url, allowedDomains) {
  const tool = createWebFetchTool({
    provider: "command",
    command: "true",
    args: [],
    allowedDomains,
    modelCaller: async () => ({
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    }),
  });
  return tool.validateInput?.({ url, question: "?" });
}

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
      allowedDomains: ["*"],
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

    // when/then:
    assert.deepStrictEqual(
      tool.maskApprovalInput?.({
        url: "https://example.com/some/path?query=1",
      }),
      { url: "https://example.com" },
    );
    assert.deepStrictEqual(
      tool.maskApprovalInput?.({ url: "http://example.com:8080/x" }),
      { url: "http://example.com:8080" },
    );
  });

  it("returns an empty origin for non-http(s) or malformed URLs", () => {
    // given:
    const tool = createWebFetchTool({
      provider: "command",
      command: "true",
      args: [],
      modelCaller: async () => ({
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      }),
    });

    // when/then:
    assert.deepStrictEqual(
      tool.maskApprovalInput?.({ url: "file:///etc/passwd" }),
      { url: "" },
    );
    assert.deepStrictEqual(tool.maskApprovalInput?.({ url: "not a url" }), {
      url: "",
    });
    assert.deepStrictEqual(tool.maskApprovalInput?.({}), { url: "" });
  });
});

describe("createWebFetchTool#validateInput", () => {
  it("denies every URL when no allow list is configured", () => {
    // given/when/then:
    assert.ok(
      validateUrl("https://any.example.org/x", undefined) instanceof Error,
    );
  });

  it("denies every URL when the allow list is empty", () => {
    // given/when/then:
    assert.ok(validateUrl("https://example.com", []) instanceof Error);
  });

  it("treats a non-array allow list as empty instead of throwing", () => {
    // given/when/then:
    assert.ok(
      validateUrl(
        "https://example.com",
        /** @type {any} */ ("example.com"),
      ) instanceof Error,
    );
  });

  it("ignores non-string entries", () => {
    // given/when/then:
    assert.equal(
      validateUrl(
        "https://example.com",
        /** @type {any} */ ([42, null, "example.com"]),
      ),
      undefined,
    );
  });

  it("allows any host when the allow list contains '*'", () => {
    // given/when/then:
    assert.equal(validateUrl("https://any.example.org/x", ["*"]), undefined);
    assert.equal(validateUrl("http://192.168.1.1/", ["*"]), undefined);
  });

  it("still denies malformed or non-http(s) URLs with '*'", () => {
    // given/when/then:
    assert.ok(validateUrl("file:///etc/passwd", ["*"]) instanceof Error);
    assert.ok(validateUrl("not a url", ["*"]) instanceof Error);
  });

  it("matches an exact host and any subdomain", () => {
    // given/when/then:
    assert.equal(
      validateUrl("https://example.com/a", ["example.com"]),
      undefined,
    );
    assert.equal(
      validateUrl("https://a.b.example.com", ["example.com"]),
      undefined,
    );
  });

  it("supports wildcard entries that exclude the apex domain", () => {
    // given/when/then:
    assert.equal(
      validateUrl("https://a.example.com", ["*.example.com"]),
      undefined,
    );
    assert.ok(
      validateUrl("https://example.com", ["*.example.com"]) instanceof Error,
    );
  });

  it("does not match lookalike hosts", () => {
    // given/when/then:
    assert.ok(
      validateUrl("https://evil-example.com", ["example.com"]) instanceof Error,
    );
  });

  it("ignores case, scheme, port, path, and query", () => {
    // given/when/then:
    assert.equal(
      validateUrl("http://EXAMPLE.com:8080/p?q=1", ["example.com"]),
      undefined,
    );
  });

  it("matches the host even when the URL carries userinfo", () => {
    // given/when/then:
    assert.equal(
      validateUrl("https://user:pass@example.com/", ["example.com"]),
      undefined,
    );
  });

  it("does not match a trailing dot or an internationalized name", () => {
    // given/when/then:
    assert.ok(
      validateUrl("https://example.com./", ["example.com"]) instanceof Error,
    );
    assert.ok(
      validateUrl("https://münchen.example/", ["münchen.example"]) instanceof
        Error,
    );
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

  it("denies every fetch when the allow list is omitted", async () => {
    // given:
    let modelCallerCalled = false;
    const tool = createWebFetchTool({
      provider: "command",
      command: "true",
      args: [],
      modelCaller: async () => {
        modelCallerCalled = true;
        return {
          message: { role: "assistant", content: [{ type: "text", text: "" }] },
        };
      },
    });

    // when:
    const result = await tool.impl({
      url: "https://example.com",
      question: "?",
    });

    // then:
    assert.ok(result instanceof Error);
    assert.match(result.message, /Blocked by allowedDomains/);
    assert.equal(modelCallerCalled, false);
  });

  it("allows a fetch to any host when the allow list is ['*']", async () => {
    // given:
    const tool = createWebFetchTool({
      provider: "command",
      command: "true",
      args: [],
      allowedDomains: ["*"],
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
    // given: a URL whose authority WHATWG `URL` and curl read differently:
    // `URL` treats `\` as a path separator (host `example.com`), while curl
    // treats it literally and takes `@` as the userinfo separator (host
    // `evil.example`). The allow list sees `example.com`, so the URL must not
    // reach the fetch command as-is.
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

    // then: the command and the prompt must see the canonical URL, so the
    // checked host is the fetched host.
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
