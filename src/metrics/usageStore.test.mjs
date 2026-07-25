import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appendUsageRecord,
  buildUsageRecord,
  readUsageRecords,
} from "./usageStore.mjs";

/** @type {string} */
let tmpDir;
/** @type {string} */
let logPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plain-usage-"));
  logPath = path.join(tmpDir, "usage.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildUsageRecord", () => {
  it("returns null when the summary has no tokens", () => {
    const record = buildUsageRecord({
      sessionId: "s1",
      mode: "interactive",
      modelName: "m+v",
      workingDir: "/tmp",
      costSummary: {
        currency: "USD",
        unit: "1M",
        breakdown: {},
        totalCost: undefined,
      },
      now: new Date("2026-04-10T00:00:00.000Z"),
    });
    assert.equal(record, null);
  });

  it("maps breakdown tokens and preserves totalCost=null when missing", () => {
    const record = buildUsageRecord({
      sessionId: "s1",
      mode: "batch",
      modelName: "m+v",
      workingDir: "/w",
      costSummary: {
        currency: "USD",
        unit: "1M",
        breakdown: {
          "usage.input_tokens": { tokens: 100, cost: undefined },
          "usage.output_tokens": { tokens: 50, cost: undefined },
        },
        totalCost: undefined,
      },
      now: new Date("2026-04-10T01:02:03.000Z"),
    });
    assert.deepEqual(record, {
      timestamp: "2026-04-10T01:02:03.000Z",
      sessionId: "s1",
      mode: "batch",
      modelName: "m+v",
      workingDir: "/w",
      currency: "USD",
      unit: "1M",
      totalCost: null,
      tokens: {
        "usage.input_tokens": 100,
        "usage.output_tokens": 50,
      },
    });
  });
});

describe("appendUsageRecord + readUsageRecords", () => {
  it("round-trips records", async () => {
    const r1 = /** @type {const} */ ({
      timestamp: "2026-04-10T12:00:00.000Z",
      sessionId: "s1",
      mode: "interactive",
      modelName: "m+v",
      workingDir: "/w",
      currency: "USD",
      unit: "1M",
      totalCost: 0.5,
      tokens: { "usage.input_tokens": 1000 },
    });
    const r2 = /** @type {const} */ ({
      timestamp: "2026-04-11T12:00:00.000Z",
      sessionId: "s2",
      mode: "batch",
      modelName: "m+v",
      workingDir: "/w",
      currency: "JPY",
      unit: "1M",
      totalCost: null,
      tokens: { "usage.input_tokens": 2000 },
    });

    await appendUsageRecord(r1, { path: logPath });
    await appendUsageRecord(r2, { path: logPath });

    const { records, skipped } = await readUsageRecords({ path: logPath });
    assert.equal(records.length, 2);
    assert.equal(skipped.length, 0);
    assert.deepEqual(records[0], r1);
    assert.deepEqual(records[1], r2);
  });

  it("returns an empty list when the file does not exist", async () => {
    const missing = path.join(tmpDir, "nope.jsonl");
    const { records, skipped } = await readUsageRecords({ path: missing });
    assert.equal(records.length, 0);
    assert.equal(skipped.length, 0);
  });

  it("skips malformed lines and reports them", async () => {
    await fs.writeFile(
      logPath,
      [
        JSON.stringify({
          timestamp: "2026-04-10T12:00:00.000Z",
          sessionId: "s1",
          mode: "interactive",
          modelName: "m+v",
          workingDir: "/w",
          currency: "USD",
          unit: "1M",
          totalCost: 0.5,
          tokens: { a: 1 },
        }),
        "not json",
        JSON.stringify({ missing: "fields" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const { records, skipped } = await readUsageRecords({ path: logPath });
    assert.equal(records.length, 1);
    assert.equal(skipped.length, 2);
  });

  it("creates the parent directory when missing", async () => {
    const nested = path.join(tmpDir, "a", "b", "usage.jsonl");
    await appendUsageRecord(
      {
        timestamp: "2026-04-10T12:00:00.000Z",
        sessionId: "s1",
        mode: "interactive",
        modelName: "m+v",
        workingDir: "/w",
        currency: "USD",
        unit: "1M",
        totalCost: 0.5,
        tokens: { a: 1 },
      },
      { path: nested },
    );
    const stat = await fs.stat(nested);
    assert.ok(stat.isFile());
  });
});
