import assert from "node:assert";
import test, { describe } from "node:test";
import { signAwsRequest } from "./awsSigV4.mjs";

describe("signAwsRequest", () => {
  test("produces correct Authorization header structure", (t) => {
    // given: a fixed date and request parameters
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2024-01-15T12:30:00.000Z"),
    });

    // when: signing the request
    const result = signAwsRequest(
      {
        method: "POST",
        hostname: "bedrock-runtime.us-east-1.amazonaws.com",
        path: "/model/test-model/converse-stream",
        headers: {
          host: "bedrock-runtime.us-east-1.amazonaws.com",
          "Content-Type": "application/json",
        },
        body: '{"messages":[]}',
      },
      {
        region: "us-east-1",
        service: "bedrock",
        credentials: {
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
      },
    );

    // then: the Authorization header matches the known-correct signature
    assert.equal(
      result.headers.Authorization,
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20240115/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=e2ccf415c6a9959ede96069e7252fd5294bbb2eba00c60676beec49ad606a375",
    );
    assert.equal(result.headers["x-amz-date"], "20240115T123000Z");
    assert.equal(result.headers["x-amz-security-token"], undefined);
    assert.equal(result.method, "POST");
    assert.equal(result.body, '{"messages":[]}');
  });

  test("includes x-amz-security-token when sessionToken is provided", (t) => {
    // given: a fixed date and credentials with a session token
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2024-01-15T12:30:00.000Z"),
    });

    // when: signing the request
    const result = signAwsRequest(
      {
        method: "POST",
        hostname: "bedrock-runtime.ap-northeast-1.amazonaws.com",
        path: "/model/test-model/converse-stream",
        headers: {
          host: "bedrock-runtime.ap-northeast-1.amazonaws.com",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      {
        region: "ap-northeast-1",
        service: "bedrock",
        credentials: {
          accessKeyId: "ASIAXXX",
          secretAccessKey: "secretXXX",
          sessionToken: "tokenXXX",
        },
      },
    );

    // then: the session token is included in the signed headers
    assert.equal(result.headers["x-amz-security-token"], "tokenXXX");
    assert.match(
      result.headers.Authorization,
      /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token/,
    );
  });

  test("signature is deterministic for same inputs", (t) => {
    // given: a fixed date and identical request parameters
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2024-01-15T12:30:00.000Z"),
    });

    const args = /** @type {const} */ ([
      {
        method: "POST",
        hostname: "bedrock-runtime.us-east-1.amazonaws.com",
        path: "/model/m/converse-stream",
        headers: {
          host: "bedrock-runtime.us-east-1.amazonaws.com",
          "Content-Type": "application/json",
        },
        body: '{"hello":"world"}',
      },
      {
        region: "us-east-1",
        service: "bedrock",
        credentials: {
          accessKeyId: "AKID",
          secretAccessKey: "SECRET",
        },
      },
    ]);

    // when: signing the same request twice
    const a = signAwsRequest(...args);
    const b = signAwsRequest(...args);

    // then: both signatures are identical
    assert.equal(a.headers.Authorization, b.headers.Authorization);
  });
});
