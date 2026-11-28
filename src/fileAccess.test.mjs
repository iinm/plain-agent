import assert from "node:assert/strict";
import { it } from "node:test";
import { createFileAccess } from "./fileAccess.mjs";
import { createReadFileTool } from "./tools/readFile.mjs";

it("returns a read_file error when the sandbox times out before yielding a line", async (t) => {
  // given: the wrapper stays open without sending file data.
  const files = createFileAccess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)", "--"],
  });
  const schedule = globalThis.setTimeout;
  /** @type {(...args: Parameters<typeof globalThis.setTimeout>) => ReturnType<typeof globalThis.setTimeout>} */
  const scheduleOperation = (callback, delay, ...args) =>
    schedule(callback, delay === 300_000 ? 75 : delay, ...args);
  t.mock.method(globalThis, "setTimeout", scheduleOperation);

  // when:
  const result = await createReadFileTool(files).impl({
    filePath: "waiting.txt",
  });

  // then:
  assert.ok(result instanceof Error);
  assert.match(result.message, /timed out/i);
});
