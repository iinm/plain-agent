import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { loadAwsCredentials, signRequest } from "./awsSigV4.mjs";

describe("signRequest", () => {
  test("produces correct Authorization header structure", (t) => {
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2024-01-15T12:30:00.000Z"),
    });

    const result = signRequest(
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

    assert.match(
      result.headers.Authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20240115\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[a-f0-9]{64}$/,
    );
    assert.equal(result.headers["x-amz-date"], "20240115T123000Z");
    assert.equal(result.headers["x-amz-security-token"], undefined);
    assert.equal(result.method, "POST");
    assert.equal(result.body, '{"messages":[]}');
  });

  test("includes x-amz-security-token when sessionToken is provided", (t) => {
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2024-01-15T12:30:00.000Z"),
    });

    const result = signRequest(
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

    assert.equal(result.headers["x-amz-security-token"], "tokenXXX");
    assert.match(
      result.headers.Authorization,
      /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token/,
    );
  });

  test("signature is deterministic for same inputs", (t) => {
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

    const a = signRequest(...args);
    const b = signRequest(...args);
    assert.equal(a.headers.Authorization, b.headers.Authorization);
  });
});

describe("loadAwsCredentials", () => {
  /** @type {string} */
  let tmpDir;
  /** @type {string} */
  let origConfigFile;
  /** @type {string} */
  let origCredsFile;

  test("loads static credentials from credentials file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aws-test-"));
    origConfigFile = process.env.AWS_CONFIG_FILE || "";
    origCredsFile = process.env.AWS_SHARED_CREDENTIALS_FILE || "";

    const credPath = join(tmpDir, "credentials");
    await writeFile(
      credPath,
      `[test-profile]
aws_access_key_id = AKIATEST
aws_secret_access_key = secretTEST
aws_session_token = tokenTEST
`,
    );

    process.env.AWS_CONFIG_FILE = join(tmpDir, "config");
    process.env.AWS_SHARED_CREDENTIALS_FILE = credPath;

    try {
      const creds = await loadAwsCredentials("test-profile");
      assert.equal(creds.accessKeyId, "AKIATEST");
      assert.equal(creds.secretAccessKey, "secretTEST");
      assert.equal(creds.sessionToken, "tokenTEST");
    } finally {
      process.env.AWS_CONFIG_FILE = origConfigFile;
      process.env.AWS_SHARED_CREDENTIALS_FILE = origCredsFile;
      await rm(tmpDir, { recursive: true });
    }
  });

  test("loads static credentials from config file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aws-test-"));
    origConfigFile = process.env.AWS_CONFIG_FILE || "";
    origCredsFile = process.env.AWS_SHARED_CREDENTIALS_FILE || "";

    const configPath = join(tmpDir, "config");
    await writeFile(
      configPath,
      `[profile my-profile]
aws_access_key_id = AKIACONFIG
aws_secret_access_key = secretCONFIG
`,
    );

    process.env.AWS_CONFIG_FILE = configPath;
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(tmpDir, "credentials");

    try {
      const creds = await loadAwsCredentials("my-profile");
      assert.equal(creds.accessKeyId, "AKIACONFIG");
      assert.equal(creds.secretAccessKey, "secretCONFIG");
      assert.equal(creds.sessionToken, undefined);
    } finally {
      process.env.AWS_CONFIG_FILE = origConfigFile;
      process.env.AWS_SHARED_CREDENTIALS_FILE = origCredsFile;
      await rm(tmpDir, { recursive: true });
    }
  });

  test("throws when no credentials found", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "aws-test-"));
    origConfigFile = process.env.AWS_CONFIG_FILE || "";
    origCredsFile = process.env.AWS_SHARED_CREDENTIALS_FILE || "";

    process.env.AWS_CONFIG_FILE = join(tmpDir, "config");
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(tmpDir, "credentials");

    try {
      await assert.rejects(() => loadAwsCredentials("nonexistent"), {
        message: /No credentials found for profile "nonexistent"/,
      });
    } finally {
      process.env.AWS_CONFIG_FILE = origConfigFile;
      process.env.AWS_SHARED_CREDENTIALS_FILE = origCredsFile;
      await rm(tmpDir, { recursive: true });
    }
  });
});
