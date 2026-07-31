import assert from "node:assert";
import test, { describe } from "node:test";
import { readOpenAIStreamData } from "./openai.mjs";

describe("readOpenAIStreamData", () => {
  /** @param {string[]} chunks */
  const makeReader = (chunks) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return stream.getReader();
  };

  test("parses events that include event and data lines", async () => {
    // given: a standard OpenAI SSE stream with event: and data: lines
    const reader = makeReader([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
    ]);

    // when: parsing the stream
    const events = [];
    for await (const event of readOpenAIStreamData(reader)) {
      events.push(event);
    }

    // then: both events are yielded in order
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "response.created");
    assert.equal(events[1].type, "response.completed");
  });

  test("parses data-only events without event lines", async () => {
    // given: a bedrock-mantle style stream with only data: lines
    const reader = makeReader([
      'data: {"type":"response.created","response":{"id":"r1"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
    ]);

    // when: parsing the stream
    const events = [];
    for await (const event of readOpenAIStreamData(reader)) {
      events.push(event);
    }

    // then: both events are yielded in order
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "response.created");
    assert.equal(events[1].type, "response.completed");
  });
});
