import assert from "node:assert";
import { describe, it } from "node:test";
import { createCostTracker } from "./costTracker.mjs";

describe("createCostTracker", () => {
  it("records usage objects", () => {
    const tracker = createCostTracker();
    tracker.recordUsage({ input: 10, output: 5 });
    assert.deepStrictEqual(tracker.getAggregatedUsage(), {
      input: 10,
      output: 5,
    });
  });

  it("throws on null usage", () => {
    const tracker = createCostTracker();
    // @ts-expect-error testing invalid input
    assert.throws(() => tracker.recordUsage(null), TypeError);
  });

  it("throws on undefined usage", () => {
    const tracker = createCostTracker();
    // @ts-expect-error testing invalid input
    assert.throws(() => tracker.recordUsage(undefined), TypeError);
  });

  it("throws on primitive usage", () => {
    const tracker = createCostTracker();
    // @ts-expect-error testing invalid input
    assert.throws(() => tracker.recordUsage(42), TypeError);
  });

  it("returns false when empty", () => {
    const tracker = createCostTracker();
    assert.equal(tracker.hasUsage(), false);
  });

  it("returns true after recording", () => {
    const tracker = createCostTracker();
    tracker.recordUsage({ a: 1 });
    assert.equal(tracker.hasUsage(), true);
  });

  it("calculates cost with config", () => {
    const tracker = createCostTracker({
      currency: "USD",
      unit: "1M",
      costs: { input: 1, output: 2 },
    });
    tracker.recordUsage({ input: 1_000_000, output: 500_000 });
    const summary = tracker.calculateCost();
    assert.equal(summary.currency, "USD");
    assert.equal(summary.unit, "1M");
    assert.equal(summary.totalCost, 2);
    assert.equal(summary.breakdown.input.cost, 1);
    assert.equal(summary.breakdown.output.cost, 1);
  });

  it("returns undefined totalCost when no pricing", () => {
    const tracker = createCostTracker();
    tracker.recordUsage({ input: 100 });
    const summary = tracker.calculateCost();
    assert.equal(summary.totalCost, undefined);
  });

  it("freezes the returned cost summary", () => {
    const tracker = createCostTracker({
      currency: "USD",
      unit: "1M",
      costs: { a: 1 },
    });
    tracker.recordUsage({ a: 100 });
    const summary = tracker.calculateCost();
    assert.equal(Object.isFrozen(summary), true);
  });

  it("throws on invalid cost config type", () => {
    // @ts-expect-error testing invalid config
    assert.throws(() => createCostTracker("bad"), TypeError);
  });

  it("throws on missing currency in config", () => {
    assert.throws(
      () =>
        // @ts-expect-error testing invalid config
        createCostTracker({
          unit: "1M",
          costs: { a: 1 },
        }),
      TypeError,
    );
  });

  it("throws on non-numeric cost value in config", () => {
    assert.throws(
      () =>
        createCostTracker({
          currency: "USD",
          unit: "1M",
          // @ts-expect-error testing invalid cost value
          costs: { a: "not-a-number" },
        }),
      TypeError,
    );
  });

  it("throws on unknown unit", () => {
    const tracker = createCostTracker({
      currency: "USD",
      unit: "1X",
      costs: { a: 1 },
    });
    tracker.recordUsage({ a: 100 });
    assert.throws(() => tracker.calculateCost(), /Unknown cost unit/);
  });

  it("uses 1K unit correctly", () => {
    const tracker = createCostTracker({
      currency: "USD",
      unit: "1K",
      costs: { a: 1 },
    });
    tracker.recordUsage({ a: 500 });
    const summary = tracker.calculateCost();
    assert.equal(summary.totalCost, 0.5);
  });
});

describe("aggregateTokens via createCostTracker", () => {
  it("recursively aggregates nested objects", () => {
    const tracker = createCostTracker();
    tracker.recordUsage({ input: { cache: 5, network: 10 } });
    tracker.recordUsage({ input: { cache: 2, network: 3 } });
    assert.deepStrictEqual(tracker.getAggregatedUsage(), {
      "input.cache": 7,
      "input.network": 13,
    });
  });

  it("ignores non-numeric and non-object values", () => {
    const tracker = createCostTracker();
    // @ts-expect-error testing invalid values
    tracker.recordUsage({ a: 1, b: "string", c: [1, 2], d: null });
    assert.deepStrictEqual(tracker.getAggregatedUsage(), { a: 1 });
  });
});
