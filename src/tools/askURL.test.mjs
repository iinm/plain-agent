import assert from "node:assert";
import { describe, it } from "node:test";
import { extractURLs, truncateUtf8 } from "./askURL.mjs";

describe("extractURLs", () => {
  it("returns an empty array when no http(s) URL is present", () => {
    // given:
    const text = "ftp://example.com/file no http here";

    // when:
    const result = extractURLs(text);

    // then:
    assert.deepEqual(result, []);
  });

  it("extracts a plain http and https URL", () => {
    // given:
    const text = "see http://example.com and https://example.org/path";

    // when:
    const result = extractURLs(text);

    // then:
    assert.deepEqual(result, [
      "http://example.com",
      "https://example.org/path",
    ]);
  });

  it("strips trailing punctuation introduced by surrounding prose", () => {
    // given:
    const text =
      "check https://example.com/foo. Then (https://example.com/bar), thanks!";

    // when:
    const result = extractURLs(text);

    // then:
    assert.deepEqual(result, [
      "https://example.com/foo",
      "https://example.com/bar",
    ]);
  });

  it("preserves first-seen order and removes duplicates", () => {
    // given:
    const text =
      "https://b.example.com https://a.example.com https://b.example.com";

    // when:
    const result = extractURLs(text);

    // then:
    assert.deepEqual(result, [
      "https://b.example.com",
      "https://a.example.com",
    ]);
  });

  it("keeps URL fragments and query strings intact", () => {
    // given:
    const text = "https://example.com/page?x=1&y=2#section";

    // when:
    const result = extractURLs(text);

    // then:
    assert.deepEqual(result, ["https://example.com/page?x=1&y=2#section"]);
  });
});

describe("truncateUtf8", () => {
  it("returns the original content when it is within the byte budget", () => {
    // given:
    const content = "hello";

    // when:
    const result = truncateUtf8(content, 10);

    // then:
    assert.equal(result.text, "hello");
    assert.equal(result.truncated, false);
    assert.equal(result.originalBytes, 5);
  });

  it("truncates ASCII content and appends a marker", () => {
    // given:
    const content = "abcdefghij"; // 10 bytes

    // when:
    const result = truncateUtf8(content, 4);

    // then:
    assert.equal(result.truncated, true);
    assert.equal(result.originalBytes, 10);
    assert.ok(result.text.startsWith("abcd"));
    assert.ok(result.text.includes("[truncated: 6 of 10 bytes omitted]"));
  });

  it("does not produce U+FFFD when truncation falls inside a multi-byte character", () => {
    // given: 'あ' is 3 bytes in UTF-8; the budget cuts it in half
    const content = "あいう"; // 9 bytes

    // when:
    const result = truncateUtf8(content, 4);

    // then:
    assert.equal(result.truncated, true);
    assert.equal(result.originalBytes, 9);
    assert.ok(!result.text.includes("\uFFFD"));
    assert.ok(result.text.startsWith("あ"));
  });
});
