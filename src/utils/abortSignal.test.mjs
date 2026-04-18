import assert from "node:assert";
import test, { describe } from "node:test";
import { combineSignals, sleep } from "./abortSignal.mjs";

describe("combineSignals", () => {
  test("returns a signal that aborts when the user signal aborts", () => {
    const userController = new AbortController();
    const combined = combineSignals(userController.signal, 60_000);
    assert.equal(combined.aborted, false);
    userController.abort();
    assert.equal(combined.aborted, true);
  });

  test("returns a signal that aborts when the timeout fires", async () => {
    const combined = combineSignals(undefined, 10);
    assert.equal(combined.aborted, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(combined.aborted, true);
  });

  test("returns only the timeout signal when userSignal is undefined", () => {
    const combined = combineSignals(undefined, 60_000);
    assert.equal(combined.aborted, false);
  });
});

describe("sleep", () => {
  test("resolves after the given time when not aborted", async () => {
    const start = Date.now();
    await sleep(20);
    assert.ok(Date.now() - start >= 20);
  });

  test("rejects immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => sleep(1000, controller.signal),
      (err) => err instanceof Error && err.name === "AbortError",
    );
  });

  test("rejects when signal aborts mid-sleep", async () => {
    const controller = new AbortController();
    const p = sleep(1000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      () => p,
      (err) => err instanceof Error && err.name === "AbortError",
    );
  });
});
