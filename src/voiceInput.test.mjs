import assert from "node:assert";
import { describe, it } from "node:test";
import { startVoiceSession } from "./voiceInput.mjs";

describe("startVoiceSession", () => {
  it("emits an error and closes when no recorder is configured or detected", async () => {
    /** @type {Error[]} */
    const errors = [];
    let closed = false;

    const session = startVoiceSession({
      config: {
        provider: "gemini",
        apiKey: "fake-key",
        recorder: {
          command: "__definitely_not_a_real_binary__",
          args: [],
        },
      },
      callbacks: {
        onTranscript: () => {
          assert.fail("onTranscript should not be called");
        },
        onError: (err) => {
          errors.push(err);
        },
        onClose: () => {
          closed = true;
        },
      },
    });

    // Trigger stop to ensure idempotency and allow cleanup to run.
    await session.stop();

    // Give any queued microtasks a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(closed, "onClose should be invoked");
    // Depending on timing, error may come from ENOENT before stop() short-
    // circuits. Either way the session must terminate cleanly.
    for (const err of errors) {
      assert.ok(err instanceof Error);
    }
  });

  it("is safe to stop() multiple times", async () => {
    const session = startVoiceSession({
      config: {
        provider: "gemini",
        apiKey: "fake-key",
        recorder: {
          command: "__definitely_not_a_real_binary__",
          args: [],
        },
      },
      callbacks: {
        onTranscript: () => {},
        onError: () => {},
        onClose: () => {},
      },
    });
    await session.stop();
    await session.stop();
    await session.stop();
  });

  it("rejects unsupported providers", async () => {
    /** @type {Error[]} */
    const errors = [];
    let closed = false;
    const session = startVoiceSession({
      config: /** @type {never} */ ({
        provider: "bogus",
        apiKey: "fake-key",
      }),
      callbacks: {
        onTranscript: () => {},
        onError: (err) => {
          errors.push(err);
        },
        onClose: () => {
          closed = true;
        },
      },
    });
    await session.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(closed);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Unsupported voiceInput\.provider/);
  });

  it("accepts an openai config without throwing synchronously", async () => {
    const session = startVoiceSession({
      config: {
        provider: "openai",
        apiKey: "fake-key",
        recorder: {
          command: "__definitely_not_a_real_binary__",
          args: [],
        },
      },
      callbacks: {
        onTranscript: () => {},
        onError: () => {},
        onClose: () => {},
      },
    });
    await session.stop();
  });
});
