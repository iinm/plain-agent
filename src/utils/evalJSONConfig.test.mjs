import assert from "node:assert";
import { describe, it } from "node:test";
import { evalJSONConfig } from "./evalJSONConfig.mjs";

describe("evalJSONConfig", () => {
  it("should pass through primitives", () => {
    assert.strictEqual(evalJSONConfig(123), 123);
    assert.strictEqual(evalJSONConfig("abc"), "abc");
    assert.strictEqual(evalJSONConfig(null), null);
    assert.strictEqual(evalJSONConfig(true), true);
  });

  it("should convert {$regex: string} to RegExp", () => {
    const out = evalJSONConfig({ $regex: "^a+$" });
    assert.ok(out instanceof RegExp);
    const outReg = /** @type {RegExp} */ (out);
    assert.strictEqual(outReg.source, "^a+$");
  });

  it("should not convert object with other keys", () => {
    const input = { $regex: "abc", other: 1 };
    const out = evalJSONConfig(input);
    assert.strictEqual(typeof out, "object");
    const outObj = /** @type {{$regex:string, other:number}} */ (out);
    assert.strictEqual(outObj.$regex, "abc");
    assert.strictEqual(outObj.other, 1);
  });

  it("should handle arrays and nested structures", () => {
    const input = {
      a: [{ $regex: "\\d+" }],
      b: "x",
      c: [1, { d: { $regex: "foo" } }],
    };
    const out = evalJSONConfig(input);
    const outAny = /** @type {any} */ (out);
    assert.ok(Array.isArray(outAny.a));
    assert.ok(outAny.a[0] instanceof RegExp);
    assert.strictEqual(outAny.a[0].source, "\\d+");
    assert.strictEqual(outAny.b, "x");
    assert.strictEqual(outAny.c[0], 1);
    assert.ok(outAny.c[1].d instanceof RegExp);
    assert.strictEqual(outAny.c[1].d.source, "foo");
  });

  it("should convert {$has: string} to a function", () => {
    const fn = /** @type {(value: unknown) => boolean} */ (
      evalJSONConfig({ $has: "foo" })
    );
    assert.strictEqual(typeof fn, "function");
    assert.strictEqual(fn(["foo", "foo2"]), true);
    assert.strictEqual(fn(["foo1", "foo2"]), false);
  });

  it("should convert {$has: {$regex: string}} to a function", () => {
    const fn = /** @type {(value: unknown) => boolean} */ (
      evalJSONConfig({ $has: { $regex: "^bar$" } })
    );
    assert.strictEqual(typeof fn, "function");
    assert.strictEqual(fn(["bar", "foo2"]), true);
    assert.strictEqual(fn(["bar-", "foo2"]), false);
  });

  it("should convert {$env: string} to environment variable value", () => {
    process.env.__TEST_ENV_VAR__ = "hello";
    const out = evalJSONConfig({ $env: "__TEST_ENV_VAR__" });
    assert.strictEqual(out, "hello");
    delete process.env.__TEST_ENV_VAR__;
  });

  it("should throw when $env variable is not defined", () => {
    delete process.env.__TEST_MISSING_ENV_VAR__;
    assert.throws(
      () => evalJSONConfig({ $env: "__TEST_MISSING_ENV_VAR__" }),
      /Environment variable '__TEST_MISSING_ENV_VAR__' is not defined/,
    );
  });

  it("should throw when $env value is not a string", () => {
    assert.throws(
      () => evalJSONConfig({ $env: 123 }),
      /The value of '\$env' must be a string/,
    );
  });

  it("should not treat object with $env and other keys as special", () => {
    process.env.__TEST_ENV_VAR__ = "hello";
    const out = evalJSONConfig({ $env: "__TEST_ENV_VAR__", other: 1 });
    const outAny = /** @type {any} */ (out);
    assert.strictEqual(outAny.$env, "__TEST_ENV_VAR__");
    assert.strictEqual(outAny.other, 1);
    delete process.env.__TEST_ENV_VAR__;
  });

  it("should support $env nested inside $has", () => {
    process.env.__TEST_ENV_VAR__ = "foo";
    const fn = /** @type {(value: unknown) => boolean} */ (
      evalJSONConfig({ $has: { $env: "__TEST_ENV_VAR__" } })
    );
    assert.strictEqual(typeof fn, "function");
    assert.strictEqual(fn(["foo", "bar"]), true);
    assert.strictEqual(fn(["bar", "baz"]), false);
    delete process.env.__TEST_ENV_VAR__;
  });

  it("should convert nested {$has: {$has: string}} to a function", () => {
    const fn = /** @type {(value: unknown) => boolean} */ (
      evalJSONConfig({ $has: { $has: "foo" } })
    );
    assert.strictEqual(typeof fn, "function");
    assert.strictEqual(fn([["foo", "bar"], ["baz"]]), true);
    assert.strictEqual(fn([["bar"], ["baz"]]), false);
  });
});
