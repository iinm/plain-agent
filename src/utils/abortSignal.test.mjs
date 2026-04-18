import assert from "node:assert";
import test, { describe } from "node:test";
import { abortableSleep } from "./abortSignal.mjs";

describe("abortableSleep", () => {
  test("resolves after the given time when not aborted", async () => {
    const start = Date.now();
    await abortableSleep(20);
    assert.ok(Date.now() - start >= 20);
  });

  test("rejects immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => abortableSleep(1000, controller.signal),
      (err) => err instanceof Error && err.name === "AbortError",
    );
  });

  test("rejects when signal aborts mid-sleep", async () => {
    const controller = new AbortController();
    const p = abortableSleep(1000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      () => p,
      (err) => err instanceof Error && err.name === "AbortError",
    );
  });
});
