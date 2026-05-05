import assert from "node:assert";
import { describe, it } from "node:test";
import { parseFrontmatter } from "./parseFrontmatter.mjs";

describe("parseFrontmatter", () => {
  it("should parse simple key-value pairs", () => {
    // given:
    const input = "description: Hello world\nfoo: bar";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "Hello world",
      foo: "bar",
    });
  });

  it("should handle empty values", () => {
    // given:
    const input = "description:";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "",
    });
  });

  it("should handle values with spaces", () => {
    // given:
    const input = "description: Hello world with spaces";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "Hello world with spaces",
    });
  });

  it("should handle quoted values without stripping quotes", () => {
    // given:
    const input = 'description: "quoted value"';

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: '"quoted value"',
    });
  });

  it("should handle hyphenated keys", () => {
    // given:
    const input = "user-invocable: true";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      "user-invocable": "true",
    });
  });

  it("should ignore lines without key-value format", () => {
    // given:
    const input = "\n  indented: value\nplain text\ndescription: valid\n";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "valid",
    });
  });

  it("should handle CRLF line endings", () => {
    // given:
    const input = "description: Hello\r\nfoo: bar";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "Hello",
      foo: "bar",
    });
  });

  it("should return empty object for empty string", () => {
    // given:
    const input = "";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {});
  });

  it("should trim trailing whitespace from values", () => {
    // given:
    const input = "description: Hello world   ";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "Hello world",
    });
  });

  it("should preserve leading whitespace in values", () => {
    // given:
    const input = "description:  Hello world";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: " Hello world",
    });
  });

  it("should parse literal block scalar (|) preserving newlines", () => {
    // given:
    const input = ["description: |", "  first line", "  second line"].join(
      "\n",
    );

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "first line\nsecond line",
    });
  });

  it("should parse folded block scalar (>) joining lines with spaces", () => {
    // given:
    const input = ["description: >", "  first line", "  second line"].join(
      "\n",
    );

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "first line second line",
    });
  });

  it("should preserve blank lines as newlines in literal block (|)", () => {
    // given:
    const input = ["description: |", "  first", "", "  third"].join("\n");

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "first\n\nthird",
    });
  });

  it("should turn blank lines into newlines in folded block (>)", () => {
    // given:
    const input = [
      "description: >",
      "  first paragraph",
      "  continued",
      "",
      "  second paragraph",
    ].join("\n");

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "first paragraph continued\nsecond paragraph",
    });
  });

  it("should accept chomping indicators after block style", () => {
    // given:
    const input = ["description: |-", "  first", "  second"].join("\n");

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "first\nsecond",
    });
  });

  it("should end block when next non-indented key appears", () => {
    // given:
    const input = ["description: |", "  hello", "  world", "foo: bar"].join(
      "\n",
    );

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "hello\nworld",
      foo: "bar",
    });
  });

  it("should handle deeper indentation by stripping the first line's indent", () => {
    // given:
    const input = [
      "description: |",
      "    first",
      "      nested",
      "    last",
    ].join("\n");

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "first\n  nested\nlast",
    });
  });

  it("should treat `key: > value` as a plain value, not a block", () => {
    // given:
    const input = "description: > inline";

    // when:
    const result = parseFrontmatter(input);

    // then:
    assert.deepStrictEqual(result, {
      description: "> inline",
    });
  });
});
