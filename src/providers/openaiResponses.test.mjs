import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import {
  callOpenAIResponsesModel,
  readOpenAIStreamData,
} from "./openaiResponses.mjs";

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

describe("callOpenAIResponsesModel (openai-codex)", () => {
  test("retries a 401 once with a credential rotated by another process", async (t) => {
    // given: a valid old credential that is replaced during the first request
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const oldAccessToken = createAccessToken("old");
    const newAccessToken = createAccessToken("new");
    await writeCredential(credentialPath, oldAccessToken);
    /** @type {string[]} */
    const authorizations = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (_url, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      assert.ok(authorization);
      authorizations.push(authorization);
      if (authorizations.length === 1) {
        assert.equal(authorization, `Bearer ${oldAccessToken}`);
        await writeCredential(credentialPath, newAccessToken);
        return new Response(null, { status: 401 });
      }
      assert.equal(authorization, `Bearer ${newAccessToken}`);
      return completedResponse();
    };

    // when: the first response is unauthorized and the credential has changed
    const result = await callOpenAIResponsesModel(
      { name: "openai-codex", variant: "default" },
      createModelConfig(),
      { messages: [] },
      { fetchImpl, openAICodex: { credentialPath } },
    );

    // then: the new token is used once and the streamed result is returned
    assert.ok(!(result instanceof Error));
    assert.deepEqual(authorizations, [
      `Bearer ${oldAccessToken}`,
      `Bearer ${newAccessToken}`,
    ]);
    assert.deepEqual(result.message, { role: "assistant", content: [] });
    assert.equal(result.providerTokenUsage?.input_tokens, 1);
  });

  test("does not retry an unchanged token or expose a 401 response body", async (t) => {
    // given: a valid credential and a sensitive unauthorized response
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const accessToken = createAccessToken("same");
    const responseSecret = "response-secret-that-must-not-leak";
    await writeCredential(credentialPath, accessToken);
    let fetchCount = 0;
    /** @type {typeof fetch} */
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({ error: responseSecret, accessToken }),
        {
          status: 401,
        },
      );
    };

    // when: the credential still contains the rejected token
    const result = await callOpenAIResponsesModel(
      { name: "openai-codex", variant: "default" },
      createModelConfig(),
      { messages: [] },
      { fetchImpl, openAICodex: { credentialPath } },
    );

    // then: the request stops after one attempt without exposing secrets
    assert.ok(result instanceof Error);
    assert.equal(fetchCount, 1);
    assert.match(result.message, /status=401/);
    assert.doesNotMatch(result.message, new RegExp(responseSecret));
    assert.doesNotMatch(result.message, new RegExp(accessToken));
  });

  test("does not expose malformed Codex SSE data in errors", async (t) => {
    // given: a valid credential and malformed SSE data containing a secret
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    await writeCredential(credentialPath, createAccessToken("malformed"));
    const responseSecret = "SSE_SECRET_VALUE";
    let fetchCount = 0;

    // when: the endpoint returns malformed JSON in an SSE data line
    const result = await callOpenAIResponsesModel(
      { name: "openai-codex", variant: "default" },
      createModelConfig(),
      { messages: [] },
      {
        fetchImpl: async () => {
          fetchCount += 1;
          return new Response(`data: ${responseSecret}\n\n`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        },
        openAICodex: { credentialPath },
      },
    );

    // then: the parse failure is fixed and neither message nor stack exposes data
    assert.ok(result instanceof Error);
    assert.equal(result.message, "Invalid OpenAI Codex stream response");
    assert.equal(fetchCount, 1);
    assert.equal(
      `${result.message}\n${result.stack}`.includes(responseSecret),
      false,
    );
  });

  test("does not expose malformed Codex function arguments in errors", async (t) => {
    // given: a completed response with malformed function call arguments
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    await writeCredential(credentialPath, createAccessToken("arguments"));
    const responseSecret = "FUNCTION_ARGUMENT_SECRET";
    let fetchCount = 0;

    // when: converting the completed response fails to parse the arguments
    const result = await callOpenAIResponsesModel(
      { name: "openai-codex", variant: "default" },
      createModelConfig(),
      { messages: [] },
      {
        fetchImpl: async () => {
          fetchCount += 1;
          return streamResponse({
            type: "response.completed",
            response: {
              output: [
                {
                  type: "function_call",
                  id: "call-1",
                  call_id: "call-1",
                  name: "test-tool",
                  arguments: responseSecret,
                },
              ],
            },
          });
        },
        openAICodex: { credentialPath },
      },
    );

    // then: the conversion failure is fixed and does not expose the arguments
    assert.ok(result instanceof Error);
    assert.equal(result.message, "Invalid OpenAI Codex response");
    assert.equal(fetchCount, 1);
    assert.equal(
      `${result.message}\n${result.stack}`.includes(responseSecret),
      false,
    );
  });

  test("stops on response.failed without exposing the event payload", async (t) => {
    // given: a terminal stream failure containing sensitive data
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const accessToken = createAccessToken("failed");
    const responseSecret = "failed-event-secret-that-must-not-leak";
    await writeCredential(credentialPath, accessToken);
    const errorMock = t.mock.method(console, "error", () => {});
    let fetchCount = 0;
    /** @type {number[]} */
    const sleeps = [];

    // when: the endpoint returns response.failed
    const result = await callOpenAIResponsesModel(
      { name: "openai-codex", variant: "default" },
      createModelConfig(),
      { messages: [] },
      {
        fetchImpl: async () => {
          fetchCount += 1;
          return streamResponse({
            type: "response.failed",
            response: { error: { message: responseSecret, accessToken } },
          });
        },
        openAICodex: { credentialPath },
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    );

    // then: the request stops once and neither errors nor logs expose the payload
    assert.ok(result instanceof Error);
    assert.equal(result.message, "OpenAI response failed");
    assert.equal(fetchCount, 1);
    assert.deepEqual(sleeps, []);
    assert.doesNotMatch(result.message, new RegExp(responseSecret));
    const diagnostics = errorMock.mock.calls
      .flatMap((call) => call.arguments)
      .map(String)
      .join("\n");
    assert.doesNotMatch(diagnostics, new RegExp(responseSecret));
  });

  test("limits incomplete stream retries without exposing event payloads", async (t) => {
    // given: an endpoint that never completes its streams
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const accessToken = createAccessToken("incomplete");
    const responseSecret = "incomplete-event-secret-that-must-not-leak";
    await writeCredential(credentialPath, accessToken);
    const errorMock = t.mock.method(console, "error", () => {});
    let fetchCount = 0;
    /** @type {number[]} */
    const sleeps = [];

    // when: every stream ends with an event whose type contains a secret
    const result = await callOpenAIResponsesModel(
      { name: "openai-codex", variant: "default" },
      createModelConfig(),
      { messages: [] },
      {
        fetchImpl: async () => {
          fetchCount += 1;
          return streamResponse({
            type: responseSecret,
            response: { secret: responseSecret, accessToken },
          });
        },
        openAICodex: { credentialPath },
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    );

    // then: retries stop without exposing the event type, payload, or token
    assert.ok(result instanceof Error);
    assert.equal(
      result.message,
      "OpenAI stream did not complete after retries",
    );
    assert.equal(fetchCount, 6);
    assert.deepEqual(sleeps, [2000, 4000, 8000, 16000, 16000]);
    assert.equal(
      `${result.message}\n${result.stack}`.includes(responseSecret),
      false,
    );
    const diagnostics = errorMock.mock.calls
      .flatMap((call) => call.arguments)
      .map(String)
      .join("\n");
    assert.doesNotMatch(diagnostics, new RegExp(responseSecret));
    assert.doesNotMatch(diagnostics, new RegExp(accessToken));
  });

  test("does not re-enable Codex authentication retry after other retries", async (t) => {
    // given: token rotation followed by rate limiting and an incomplete stream
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const oldAccessToken = createAccessToken("old");
    const newAccessToken = createAccessToken("new");
    await writeCredential(credentialPath, oldAccessToken);
    /** @type {string[]} */
    const authorizations = [];
    /** @type {number[]} */
    const sleeps = [];
    t.mock.method(console, "error", () => {});
    /** @type {typeof fetch} */
    const fetchImpl = async (_url, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      assert.ok(authorization);
      authorizations.push(authorization);
      if (authorizations.length === 1) {
        await writeCredential(credentialPath, newAccessToken);
        return new Response(null, { status: 401 });
      }
      if (authorizations.length === 2) {
        return new Response(null, { status: 429 });
      }
      if (authorizations.length === 3) {
        return streamResponse({
          type: "response.in_progress",
          response: {},
        });
      }
      return new Response(null, { status: 401 });
    };

    // when: a second 401 arrives after the authentication retry was consumed
    const result = await callOpenAIResponsesModel(
      { name: "openai-codex", variant: "default" },
      createModelConfig(),
      { messages: [] },
      {
        fetchImpl,
        openAICodex: { credentialPath },
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    );

    // then: the final 401 is terminal and no fifth request is sent
    assert.ok(result instanceof Error);
    assert.match(result.message, /status=401/);
    assert.deepEqual(authorizations, [
      `Bearer ${oldAccessToken}`,
      `Bearer ${newAccessToken}`,
      `Bearer ${newAccessToken}`,
      `Bearer ${newAccessToken}`,
    ]);
    assert.deepEqual(sleeps, [2000, 4000]);
  });
});

/**
 * @param {import("node:test").TestContext} t
 */
async function createTempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "plain-agent-openai-responses-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * @param {string} credentialPath
 * @param {string} accessToken
 */
async function writeCredential(credentialPath, accessToken) {
  await fs.mkdir(path.dirname(credentialPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    credentialPath,
    JSON.stringify({
      accessToken,
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600 * 1000,
    }),
    { mode: 0o600 },
  );
}

/** @param {string} marker */
function createAccessToken(marker) {
  const encode = (/** @type {unknown} */ value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    marker,
  })}.signature`;
}

/** @returns {import("./openaiResponses").OpenAIModelConfig} */
function createModelConfig() {
  return {
    model: "gpt-test",
    reasoning: { effort: "medium", summary: "auto" },
  };
}

function completedResponse() {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "response-1",
        object: "response",
        output: [],
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 3,
        },
      },
    })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/** @param {unknown} event */
function streamResponse(event) {
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
