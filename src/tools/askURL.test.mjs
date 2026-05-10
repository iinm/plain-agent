import assert from "node:assert";
import { describe, it } from "node:test";
import { extractURLs, truncateText } from "./askURL.mjs";

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
