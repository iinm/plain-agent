import assert from "node:assert";
import { describe, it } from "node:test";
import { toOneLine } from "./toOneLine.mjs";

describe("toOneLine", () => {
  it("should return single-line strings unchanged", () => {
    // given:
    const input = "hello world";

    // when:
    const result = toOneLine(input);

    // then:
    assert.strictEqual(result, "hello world");
  });

  it("should convert a single newline to a space", () => {
    // given:
    const input = "hello\nworld";

    // when:
    const result = toOneLine(input);

    // then:
    assert.strictEqual(result, "hello world");
  });

  it("should collapse whitespace surrounding a newline into one space", () => {
    // given:
    const input = "hello   \n   world";

    // when:
    const result = toOneLine(input);

    // then:
    assert.strictEqual(result, "hello world");
  });

  it("should collapse multiple newlines into a single space", () => {
    // given:
    const input = "hello\n\n\nworld";

    // when:
    const result = toOneLine(input);

    // then:
    assert.strictEqual(result, "hello world");
  });

  it("should trim leading and trailing whitespace", () => {
    // given:
    const input = "  hello  ";

    // when:
    const result = toOneLine(input);

    // then:
    assert.strictEqual(result, "hello");
  });

  it("should handle CRLF line endings", () => {
    // given:
    const input = "hello\r\nworld";

    // when:
    const result = toOneLine(input);

    // then:
    assert.strictEqual(result, "hello world");
  });

  it("should return an empty string for whitespace-only input", () => {
    // given:
    const input = "   \n\n  ";

    // when:
    const result = toOneLine(input);

    // then:
    assert.strictEqual(result, "");
  });
});
