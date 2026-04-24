import assert from "node:assert";
import { describe, it } from "node:test";
import {
  aggregateUsage,
  defaultPeriod,
  formatCostReport,
  formatLocalDate,
  parseDateOnly,
} from "./cliCost.mjs";

/**
 * Build a usage record with sensible defaults for testing.
 * @param {Partial<import("./usageStore.mjs").UsageRecord>} overrides
 * @returns {import("./usageStore.mjs").UsageRecord}
 */
function makeRecord(overrides) {
  return {
    timestamp: "2026-04-10T12:34:56.000Z",
    sessionId: "s1",
    mode: "interactive",
    modelName: "model+variant",
    workingDir: "/tmp",
    currency: "USD",
    unit: "1M",
    totalCost: 0.12,
    tokens: { input: 1000, output: 500 },
    ...overrides,
  };
}

describe("parseDateOnly", () => {
  it("parses a valid YYYY-MM-DD string", () => {
    const d = parseDateOnly("2026-04-23");
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 3);
    assert.equal(d.getDate(), 23);
  });

  it("rejects malformed strings", () => {
    assert.throws(() => parseDateOnly("2026/04/23"));
    assert.throws(() => parseDateOnly("26-04-23"));
    assert.throws(() => parseDateOnly(""));
  });

  it("rejects invalid calendar dates", () => {
    assert.throws(() => parseDateOnly("2026-02-30"));
    assert.throws(() => parseDateOnly("2026-13-01"));
  });
});

describe("defaultPeriod", () => {
  it("starts from the first of the current month", () => {
    const now = new Date(2026, 3, 23, 15, 0, 0);
    const period = defaultPeriod(now);
    assert.equal(period.from, "2026-04-01");
    assert.equal(period.to, "2026-04-23");
  });
});

describe("formatLocalDate", () => {
  it("pads month and day", () => {
    const d = new Date(2026, 0, 5);
    assert.equal(formatLocalDate(d), "2026-01-05");
  });
});

describe("aggregateUsage", () => {
  // Use a timezone-independent timestamp: noon UTC on an ambiguous day can
  // shift to a different local date, so pick timestamps that are the same
  // local date in any reasonable timezone by using mid-day local-style
  // ISO strings without Z.
  const period = { from: "2026-04-01", to: "2026-04-30" };

  it("groups per day and sums costs per currency", () => {
    const records = [
      makeRecord({
        timestamp: localIso(2026, 4, 10, 10),
        totalCost: 0.1,
        currency: "USD",
      }),
      makeRecord({
        timestamp: localIso(2026, 4, 10, 14),
        totalCost: 0.25,
        currency: "USD",
      }),
      makeRecord({
        timestamp: localIso(2026, 4, 11, 9),
        totalCost: 1.5,
        currency: "USD",
      }),
    ];
    const report = aggregateUsage(records, period);
    assert.equal(report.byCurrency.length, 1);
    const usd = report.byCurrency[0];
    assert.equal(usd.currency, "USD");
    assert.equal(usd.daily.length, 2);
    assert.equal(usd.daily[0].date, "2026-04-10");
    assert.equal(usd.daily[0].sessionCount, 2);
    assert.ok(Math.abs(usd.daily[0].totalCost - 0.35) < 1e-9);
    assert.equal(usd.daily[1].date, "2026-04-11");
    assert.equal(usd.daily[1].sessionCount, 1);
    assert.ok(Math.abs(usd.totalCost - 1.85) < 1e-9);
    assert.equal(usd.sessionCount, 3);
  });

  it("keeps currencies separate and sorts them", () => {
    const records = [
      makeRecord({
        timestamp: localIso(2026, 4, 10, 10),
        totalCost: 1,
        currency: "USD",
      }),
      makeRecord({
        timestamp: localIso(2026, 4, 10, 10),
        totalCost: 200,
        currency: "JPY",
      }),
    ];
    const report = aggregateUsage(records, period);
    assert.equal(report.byCurrency.length, 2);
    assert.equal(report.byCurrency[0].currency, "JPY");
    assert.equal(report.byCurrency[0].totalCost, 200);
    assert.equal(report.byCurrency[1].currency, "USD");
    assert.equal(report.byCurrency[1].totalCost, 1);
  });

  it("excludes records outside the period", () => {
    const records = [
      makeRecord({ timestamp: localIso(2026, 3, 31, 23), totalCost: 1 }),
      makeRecord({ timestamp: localIso(2026, 4, 1, 1), totalCost: 2 }),
      makeRecord({ timestamp: localIso(2026, 5, 1, 12), totalCost: 3 }),
    ];
    const report = aggregateUsage(records, {
      from: "2026-04-01",
      to: "2026-04-30",
    });
    assert.equal(report.byCurrency.length, 1);
    assert.equal(report.byCurrency[0].totalCost, 2);
    assert.equal(report.excludedOutOfRange, 2);
  });

  it("counts records with no pricing separately", () => {
    const records = [
      makeRecord({
        timestamp: localIso(2026, 4, 10, 10),
        totalCost: null,
      }),
      makeRecord({ timestamp: localIso(2026, 4, 10, 10), totalCost: 1 }),
    ];
    const report = aggregateUsage(records, period);
    assert.equal(report.noPricingSessionCount, 1);
    assert.equal(report.byCurrency.length, 1);
    assert.equal(report.byCurrency[0].totalCost, 1);
    assert.equal(report.byCurrency[0].sessionCount, 1);
  });

  it("rejects a reversed period", () => {
    assert.throws(() =>
      aggregateUsage([], { from: "2026-04-10", to: "2026-04-01" }),
    );
  });
});

describe("formatCostReport", () => {
  const period = { from: "2026-04-01", to: "2026-04-30" };

  it("prints a clear message when there is no data", () => {
    const report = aggregateUsage([], period);
    const out = formatCostReport(report, { color: false });
    assert.match(out, /Period: 2026-04-01 to 2026-04-30/);
    assert.match(out, /No usage recorded in this period\./);
  });

  it("renders daily breakdown and total per currency", () => {
    const records = [
      makeRecord({
        timestamp: localIso(2026, 4, 10, 10),
        totalCost: 0.1,
        currency: "USD",
      }),
      makeRecord({
        timestamp: localIso(2026, 4, 11, 10),
        totalCost: 0.2,
        currency: "USD",
      }),
      makeRecord({
        timestamp: localIso(2026, 4, 11, 10),
        totalCost: 150,
        currency: "JPY",
      }),
    ];
    const out = formatCostReport(aggregateUsage(records, period), {
      color: false,
    });
    assert.match(out, /Daily cost \(JPY\):/);
    assert.match(out, /2026-04-11\s+150\.0000 JPY\s+\(1 session\)/);
    assert.match(out, /Daily cost \(USD\):/);
    assert.match(out, /2026-04-10\s+0\.1000 USD\s+\(1 session\)/);
    assert.match(out, /2026-04-11\s+0\.2000 USD\s+\(1 session\)/);
    assert.match(out, /Total: 0\.3000 USD \(2 sessions\)/);
    assert.match(out, /Total: 150\.0000 JPY \(1 session\)/);
  });
});

/**
 * Build an ISO-like timestamp that evaluates to the same local date as
 * `year-month-day` in any reasonable timezone. We use a non-UTC (`Z`)
 * timestamp at local noon so the Date parser treats it as local time.
 *
 * @param {number} year
 * @param {number} month 1-indexed
 * @param {number} day
 * @param {number} hour 0-23
 * @returns {string}
 */
function localIso(year, month, day, hour) {
  const d = new Date(year, month - 1, day, hour, 0, 0);
  return d.toISOString();
}
