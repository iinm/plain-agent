import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  loginOpenAICodex,
  logoutOpenAICodex,
  prepareOpenAICodexRequest,
} from "./openaiCodex.mjs";

const execFileAsync = promisify(execFile);

describe("loginOpenAICodex", () => {
  it("completes Device Flow, handles pending responses and slow_down, and stores a private credential", async (t) => {
    // given: device authorization pending responses followed by slow_down
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(
      directory,
      "credentials",
      "openai-codex.json",
    );
    const accessToken = createAccessToken("account-1");
    /** @type {{ url: string, init: RequestInit | undefined }[]} */
    const calls = [];
    /** @type {number[]} */
    const sleeps = [];
    let now = 1000;
    let pollCount = 0;
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
      const requestUrl = String(url);
      calls.push({ url: requestUrl, init });
      if (requestUrl.endsWith("/deviceauth/usercode")) {
        return jsonResponse(200, {
          device_auth_id: "device-1",
          user_code: "USER-CODE",
          interval: "5",
        });
      }
      if (requestUrl.endsWith("/deviceauth/token")) {
        pollCount += 1;
        if (pollCount === 1) {
          return jsonResponse(403, { error: "authorization_pending" });
        }
        if (pollCount === 2) {
          return jsonResponse(404, {});
        }
        if (pollCount === 3) {
          return jsonResponse(400, {
            error: "deviceauth_authorization_pending",
          });
        }
        if (pollCount === 4) {
          return jsonResponse(400, { error: "slow_down", interval: 7 });
        }
        return jsonResponse(200, {
          authorization_code: "authorization-code",
          code_verifier: "code-verifier",
        });
      }
      if (requestUrl.endsWith("/oauth/token")) {
        return jsonResponse(200, {
          access_token: accessToken,
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      throw new Error(`Unexpected URL: ${requestUrl}`);
    };
    /** @type {{ verificationUrl: string, userCode: string, expiresInSeconds: number }[]} */
    const deviceNotifications = [];

    // when: logging in
    await loginOpenAICodex({
      credentialPath,
      fetchImpl,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      onDeviceCode(device) {
        deviceNotifications.push(device);
      },
    });

    // then: the user sees the code and the rotated polling interval is used
    assert.deepEqual(deviceNotifications, [
      {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "USER-CODE",
        expiresInSeconds: 900,
      },
    ]);
    assert.deepEqual(sleeps, [5000, 5000, 5000, 7000]);
    const exchange = calls.find((call) => call.url.endsWith("/oauth/token"));
    assert.ok(exchange?.init?.body);
    assert.equal(exchange.init.method, "POST");
    assert.equal(
      exchange.init.body.toString(),
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code: "authorization-code",
        code_verifier: "code-verifier",
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
      }).toString(),
    );
    const saved = JSON.parse(await fs.readFile(credentialPath, "utf8"));
    assert.deepEqual(saved, {
      accessToken,
      refreshToken: "refresh-token",
      expiresAt: 23000 + 3600 * 1000,
    });
    assert.equal(
      (await fs.stat(path.dirname(credentialPath))).mode & 0o777,
      0o700,
    );
    assert.equal((await fs.stat(credentialPath)).mode & 0o777, 0o600);
    await assert.rejects(fs.stat(`${credentialPath}.lock`), { code: "ENOENT" });
  });

  it("stops polling at the Device Flow timeout", async (t) => {
    // given: authorization that never completes
    const directory = await createTempDirectory(t);
    let now = 0;
    let pollCount = 0;
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/deviceauth/usercode")) {
        return jsonResponse(200, {
          device_auth_id: "device-1",
          user_code: "USER-CODE",
          interval: 5,
        });
      }
      if (requestUrl.endsWith("/deviceauth/token")) {
        pollCount += 1;
        return jsonResponse(403, {});
      }
      throw new Error("Token exchange must not start");
    };

    // when: the 15-minute flow is shortened for the test
    const login = loginOpenAICodex({
      credentialPath: path.join(directory, "credential.json"),
      fetchImpl,
      deviceFlowTimeoutMs: 10000,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      onDeviceCode() {},
    });

    // then: polling stops at the deadline
    await assert.rejects(login, /device authorization timed out/);
    assert.equal(pollCount, 2);
  });

  it("does not expose token response contents in errors", async (t) => {
    // given: a token endpoint error containing a sensitive value
    const directory = await createTempDirectory(t);
    const secret = "secret-that-must-not-leak";
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/deviceauth/usercode")) {
        return jsonResponse(200, {
          device_auth_id: "device-1",
          user_code: "USER-CODE",
          interval: 5,
        });
      }
      if (requestUrl.endsWith("/deviceauth/token")) {
        return jsonResponse(200, {
          authorization_code: "authorization-code",
          code_verifier: "code-verifier",
        });
      }
      return jsonResponse(400, { error: secret });
    };

    // when: token exchange fails
    const error = await loginOpenAICodex({
      credentialPath: path.join(directory, "credential.json"),
      fetchImpl,
      onDeviceCode() {},
    }).catch((error) => error);

    // then: only the status is reported
    assert.match(error.message, /status=400/);
    assert.doesNotMatch(error.message, new RegExp(secret));
  });

  for (const body of [null, [], {}]) {
    it(`rejects an invalid device code response: ${JSON.stringify(body)}`, async (t) => {
      // given: a successful HTTP response with an invalid JSON payload
      const directory = await createTempDirectory(t);
      /** @type {typeof fetch} */
      const fetchImpl = async () => jsonResponse(200, body);

      // when: requesting a device code
      const login = loginOpenAICodex({
        credentialPath: path.join(directory, "credential.json"),
        fetchImpl,
        onDeviceCode() {},
      });

      // then: the payload is rejected as a device code response
      await assert.rejects(login, /Invalid OpenAI Codex device code response/);
    });
  }

  it("rejects a non-object device authorization response", async (t) => {
    // given: a device authorization endpoint that returns JSON null
    const directory = await createTempDirectory(t);
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/deviceauth/usercode")) {
        return jsonResponse(200, {
          device_auth_id: "device-1",
          user_code: "USER-CODE",
          interval: 5,
        });
      }
      return jsonResponse(200, null);
    };

    // when: polling device authorization
    const login = loginOpenAICodex({
      credentialPath: path.join(directory, "credential.json"),
      fetchImpl,
      onDeviceCode() {},
    });

    // then: the payload is rejected without a TypeError
    await assert.rejects(
      login,
      /Invalid OpenAI Codex device authorization response/,
    );
  });

  it("rejects a non-object token exchange response", async (t) => {
    // given: a token endpoint that returns a JSON array
    const directory = await createTempDirectory(t);
    /** @type {typeof fetch} */
    const fetchImpl = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/deviceauth/usercode")) {
        return jsonResponse(200, {
          device_auth_id: "device-1",
          user_code: "USER-CODE",
          interval: 5,
        });
      }
      if (requestUrl.endsWith("/deviceauth/token")) {
        return jsonResponse(200, {
          authorization_code: "authorization-code",
          code_verifier: "code-verifier",
        });
      }
      return jsonResponse(200, []);
    };

    // when: exchanging the authorization code
    const login = loginOpenAICodex({
      credentialPath: path.join(directory, "credential.json"),
      fetchImpl,
      onDeviceCode() {},
    });

    // then: the payload is rejected as a token exchange response
    await assert.rejects(login, /Invalid OpenAI Codex token exchange response/);
  });
});

describe("prepareOpenAICodexRequest", () => {
  it("guides the user to login when no credential exists", async (t) => {
    // given: an empty credential directory
    const directory = await createTempDirectory(t);

    // when: preparing a request
    const preparation = prepareOpenAICodexRequest(createRequest(), {
      credentialPath: path.join(directory, "missing.json"),
    });

    // then: the login command is included in the error
    await assert.rejects(preparation, /plain auth login openai-codex/);
  });

  it("uses a valid credential and applies Codex request requirements", async (t) => {
    // given: a valid credential and a generic Responses request
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const accessToken = createAccessToken("account-1");
    await writeCredential(credentialPath, {
      accessToken,
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600 * 1000,
    });
    const request = {
      ...createRequest(),
      store: true,
      max_output_tokens: 123,
    };
    let fetchCount = 0;

    // when: preparing the request
    const prepared = await prepareOpenAICodexRequest(request, {
      credentialPath,
      customHeaders: {
        "x-custom": "custom",
        Authorization: "invalid",
        authorization: "invalid-lowercase",
        "content-type": "text/plain",
        "openai-beta": "invalid",
        "chatgpt-account-id": "invalid",
      },
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("Refresh is not required");
      },
    });

    // then: endpoint, headers, and body match the Codex contract
    assert.equal(
      prepared.url,
      "https://chatgpt.com/backend-api/codex/responses",
    );
    assert.deepEqual(prepared.headers, {
      "x-custom": "custom",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": "account-1",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      originator: "plain-agent",
    });
    const body = JSON.parse(prepared.body);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.equal(body.max_output_tokens, undefined);
    assert.equal(fetchCount, 0);
    assert.equal(
      [...new Headers(prepared.headers).entries()].filter(
        ([name]) => name === "authorization",
      ).length,
      1,
    );
  });

  it("rejects an access token without an account ID", async (t) => {
    // given: a credential with an invalid JWT
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    await writeCredential(credentialPath, {
      accessToken: "not-a-jwt",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600 * 1000,
    });

    // when: preparing a request
    const preparation = prepareOpenAICodexRequest(createRequest(), {
      credentialPath,
    });

    // then: the malformed token is rejected
    await assert.rejects(
      preparation,
      /Failed to extract the ChatGPT account ID/,
    );
  });

  it("refreshes once for concurrent callers and saves a rotated refresh token", async (t) => {
    // given: an expired credential and two concurrent requests
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const oldAccessToken = createAccessToken("account-1", "old");
    const newAccessToken = createAccessToken("account-1", "new");
    await writeCredential(credentialPath, {
      accessToken: oldAccessToken,
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() - 1000,
    });
    let refreshCount = 0;
    /** @type {typeof fetch} */
    const fetchImpl = async (_url, init) => {
      refreshCount += 1;
      assert.equal(
        init?.body?.toString(),
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "old-refresh-token",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        }).toString(),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, {
        access_token: newAccessToken,
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      });
    };

    // when: both callers need a token
    const [first, second] = await Promise.all([
      prepareOpenAICodexRequest(createRequest(), {
        credentialPath,
        fetchImpl,
      }),
      prepareOpenAICodexRequest(createRequest(), {
        credentialPath,
        fetchImpl,
      }),
    ]);

    // then: one refresh is shared and the rotated tokens are persisted
    assert.equal(refreshCount, 1);
    assert.equal(first.headers.Authorization, `Bearer ${newAccessToken}`);
    assert.equal(second.headers.Authorization, `Bearer ${newAccessToken}`);
    const saved = JSON.parse(await fs.readFile(credentialPath, "utf8"));
    assert.equal(saved.accessToken, newAccessToken);
    assert.equal(saved.refreshToken, "new-refresh-token");
  });

  it("keeps the previous refresh token when refresh does not rotate it", async (t) => {
    // given: an expired credential and a refresh response without refresh_token
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const newAccessToken = createAccessToken("account-1", "new");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken("account-1", "old"),
      refreshToken: "existing-refresh-token",
      expiresAt: Date.now() - 1000,
    });

    // when: refreshing the access token
    const prepared = await prepareOpenAICodexRequest(createRequest(), {
      credentialPath,
      fetchImpl: async () =>
        jsonResponse(200, {
          access_token: newAccessToken,
          expires_in: 3600,
        }),
    });

    // then: the new access token and existing refresh token are persisted
    assert.equal(prepared.headers.Authorization, `Bearer ${newAccessToken}`);
    const saved = JSON.parse(await fs.readFile(credentialPath, "utf8"));
    assert.equal(saved.accessToken, newAccessToken);
    assert.equal(saved.refreshToken, "existing-refresh-token");
  });

  it("rejects an incomplete token refresh response", async (t) => {
    // given: an expired credential and a refresh response without tokens
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken("account-1", "old"),
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1000,
    });

    // when: refreshing the credential
    const preparation = prepareOpenAICodexRequest(createRequest(), {
      credentialPath,
      fetchImpl: async () => jsonResponse(200, {}),
    });

    // then: the response is rejected as a token refresh response
    await assert.rejects(
      preparation,
      /Invalid OpenAI Codex token refresh response/,
    );
  });

  it("reuses a credential refreshed by another process", async (t) => {
    // given: an expired credential and a local token endpoint
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const oldAccessToken = createAccessToken("account-1", "old");
    const newAccessToken = createAccessToken("account-1", "new");
    await writeCredential(credentialPath, {
      accessToken: oldAccessToken,
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1000,
    });
    let refreshCount = 0;
    const server = http.createServer(async (request, response) => {
      if (request.url !== "/oauth/token") {
        response.writeHead(404).end();
        return;
      }
      refreshCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: newAccessToken,
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
      );
    });
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind to a TCP port");
    }
    const authBaseURL = `http://127.0.0.1:${address.port}`;
    const childPath = path.join(directory, "refresh-child.mjs");
    const moduleURL = new URL("./openaiCodex.mjs", import.meta.url).href;
    await fs.writeFile(
      childPath,
      `import { prepareOpenAICodexRequest } from ${JSON.stringify(moduleURL)};\n` +
        "const [credentialPath, authBaseURL] = process.argv.slice(2);\n" +
        "const prepared = await prepareOpenAICodexRequest(\n" +
        "  { model: 'test', input: [] },\n" +
        "  { credentialPath, authBaseURL, lockTimeoutMs: 5000, lockRetryMs: 10 },\n" +
        ");\n" +
        "console.log(prepared.headers['chatgpt-account-id']);\n",
    );

    // when: two processes refresh the same credential concurrently
    const [first, second] = await Promise.all([
      execFileAsync(process.execPath, [childPath, credentialPath, authBaseURL]),
      execFileAsync(process.execPath, [childPath, credentialPath, authBaseURL]),
    ]);

    // then: the loser reads the winner's credential instead of refreshing again
    assert.equal(first.stdout.trim(), "account-1");
    assert.equal(second.stdout.trim(), "account-1");
    assert.equal(refreshCount, 1);
    const saved = JSON.parse(await fs.readFile(credentialPath, "utf8"));
    assert.equal(saved.accessToken, newAccessToken);
    await assert.rejects(fs.stat(`${credentialPath}.lock`), { code: "ENOENT" });
  });

  it("recovers a lock left by a crashed process", async (t) => {
    // given: an expired credential and a lock whose owner is no longer alive
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const newAccessToken = createAccessToken("account-1", "new");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken("account-1", "old"),
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1000,
    });
    const lockPath = `${credentialPath}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        id: "crashed",
        pid: 424242,
        createdAt: Date.now() - 120000,
      }),
      { mode: 0o600 },
    );

    // when: preparing a request with the dead owner detected
    const prepared = await prepareOpenAICodexRequest(createRequest(), {
      credentialPath,
      isProcessAlive: () => false,
      fetchImpl: async () =>
        jsonResponse(200, {
          access_token: newAccessToken,
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
    });

    // then: the stale lock is reclaimed and refresh completes
    assert.equal(prepared.headers.Authorization, `Bearer ${newAccessToken}`);
    await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
  });

  it("recovers an ownerless stale lock", async (t) => {
    // given: an expired credential and a stale lock without owner metadata
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const newAccessToken = createAccessToken("account-1", "new");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken("account-1", "old"),
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1000,
    });
    const lockPath = `${credentialPath}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    const staleTime = new Date(Date.now() - 120000);
    await fs.utimes(lockPath, staleTime, staleTime);

    // when: preparing a request
    const prepared = await prepareOpenAICodexRequest(createRequest(), {
      credentialPath,
      staleLockMs: 1000,
      fetchImpl: async () =>
        jsonResponse(200, {
          access_token: newAccessToken,
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
    });

    // then: the stale directory is reclaimed and refresh completes
    assert.equal(prepared.headers.Authorization, `Bearer ${newAccessToken}`);
    await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
  });

  it("does not reclaim a live owner based on lock age", async (t) => {
    // given: an old lock whose owner process is still alive
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken("account-1", "old"),
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1000,
    });
    const lockPath = `${credentialPath}.lock`;
    let now = Date.now();
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ id: "live", pid: process.pid, createdAt: now - 120000 }),
      { mode: 0o600 },
    );
    let fetchCount = 0;

    // when: the lock wait times out
    const preparation = prepareOpenAICodexRequest(createRequest(), {
      credentialPath,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      isProcessAlive: () => true,
      staleLockMs: 1,
      lockTimeoutMs: 40,
      lockRetryMs: 10,
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("Refresh must not start");
      },
    });

    // then: the live lock remains and no refresh is attempted
    await assert.rejects(preparation, /Timed out waiting/);
    assert.equal(fetchCount, 0);
    const owner = JSON.parse(
      await fs.readFile(path.join(lockPath, "owner.json"), "utf8"),
    );
    assert.equal(owner.id, "live");
  });

  it("keeps a new owner when another reclaimer uses the same stale snapshot", async (t) => {
    // given: two processes that both read the same crashed owner's lock
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const newAccessToken = createAccessToken("account-1", "new");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken("account-1", "old"),
      refreshToken: "refresh-token",
      expiresAt: 0,
    });
    const lockPath = `${credentialPath}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(lockPath, "owner-crashed.json"),
      JSON.stringify({ id: "crashed", pid: 424242, createdAt: 1 }),
      { mode: 0o600 },
    );
    const childPath = path.join(directory, "reclaim-child.mjs");
    const moduleURL = new URL("./openaiCodex.mjs", import.meta.url).href;
    await fs.writeFile(
      childPath,
      [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        `import { prepareOpenAICodexRequest } from ${JSON.stringify(moduleURL)};`,
        "const [credentialPath, role, accessToken] = process.argv.slice(2);",
        "const lockPath = credentialPath + '.lock';",
        "const staleOwnerPath = path.join(lockPath, 'owner-crashed.json');",
        "const waiters = new Map();",
        "const waitFor = (type) => new Promise((resolve) => waiters.set(type, resolve));",
        "process.on('message', (message) => {",
        "  const resolve = waiters.get(message.type);",
        "  if (resolve) { waiters.delete(message.type); resolve(); }",
        "});",
        "const originalUnlink = fs.unlink;",
        "fs.unlink = async (target) => {",
        "  if (String(target) === staleOwnerPath) {",
        "    const gate = waitFor('proceed-reclaim');",
        "    process.send({ type: 'reclaim-started' });",
        "    await gate;",
        "  }",
        "  return await originalUnlink(target);",
        "};",
        "const originalRmdir = fs.rmdir;",
        "let reportRmdir = role === '2';",
        "fs.rmdir = async (target) => {",
        "  try { return await originalRmdir(target); }",
        "  finally {",
        "    if (String(target) === lockPath && reportRmdir) {",
        "      reportRmdir = false;",
        "      process.send({ type: 'delayed-reclaim-finished' });",
        "    }",
        "  }",
        "};",
        "let refreshCount = 0;",
        "const result = await prepareOpenAICodexRequest(",
        "  { model: 'test', input: [] },",
        "  {",
        "    credentialPath,",
        "    isProcessAlive: (pid) => pid !== 424242,",
        "    lockRetryMs: 1,",
        "    lockTimeoutMs: 5000,",
        "    fetchImpl: async () => {",
        "      refreshCount += 1;",
        "      const gate = waitFor('finish-refresh');",
        "      process.send({ type: 'refresh-started' });",
        "      await gate;",
        "      return new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'new-refresh-' + role, expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });",
        "    },",
        "  },",
        ").then(",
        "  (value) => ({ status: 'success', authorization: value.headers.Authorization, refreshCount }),",
        "  (error) => ({ status: 'error', message: error.message, refreshCount }),",
        ");",
        "process.send({ type: 'result', result });",
      ].join("\n"),
    );
    const children = [
      fork(childPath, [credentialPath, "1", newAccessToken]),
      fork(childPath, [credentialPath, "2", newAccessToken]),
    ];
    t.after(() => {
      for (const child of children) {
        child.kill();
      }
    });

    // when: the first process acquires the new lock before the second reclaims
    await Promise.all(
      children.map((child) => waitForChildMessage(child, "reclaim-started")),
    );
    const firstRefreshStarted = waitForChildMessage(
      children[0],
      "refresh-started",
    );
    children[0].send({ type: "proceed-reclaim" });
    await firstRefreshStarted;
    const delayedReclaimFinished = waitForChildMessage(
      children[1],
      "delayed-reclaim-finished",
    );
    children[1].send({ type: "proceed-reclaim" });
    await delayedReclaimFinished;

    // then: the delayed reclaim preserves the new owner and one refresh is shared
    const owner = await readLockOwner(lockPath);
    assert.equal(owner.pid, children[0].pid);
    const resultPromises = children.map((child) =>
      waitForChildMessage(child, "result"),
    );
    for (const child of children) {
      child.send({ type: "finish-refresh" });
    }
    const [first, second] = await Promise.all(resultPromises);
    assert.equal(first.result.status, "success");
    assert.equal(second.result.status, "success");
    assert.equal(first.result.authorization, `Bearer ${newAccessToken}`);
    assert.equal(second.result.authorization, `Bearer ${newAccessToken}`);
    assert.equal(first.result.refreshCount, 1);
    assert.equal(second.result.refreshCount, 0);
  });

  it("does not remove a new owner created during lock release", async (t) => {
    // given: a new live lock published after the old owner metadata is removed
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    const newAccessToken = createAccessToken("account-1", "new");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken("account-1", "old"),
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 1000,
    });
    const lockPath = `${credentialPath}.lock`;
    const originalUnlink = fs.unlink;
    let newOwnerCreated = false;
    /** @type {typeof fs.unlink} */
    const unlink = async (filePath) => {
      await originalUnlink(filePath);
      const target = String(filePath);
      if (
        !newOwnerCreated &&
        path.dirname(target) === lockPath &&
        path.basename(target).startsWith("owner-")
      ) {
        newOwnerCreated = true;
        await fs.rmdir(lockPath);
        await fs.mkdir(lockPath, { mode: 0o700 });
        await fs.writeFile(
          path.join(lockPath, "owner-next-owner.json"),
          JSON.stringify({
            id: "next-owner",
            pid: process.pid,
            createdAt: Date.now(),
          }),
          { mode: 0o600 },
        );
      }
    };
    t.mock.method(fs, "unlink", unlink);

    // when: refresh completes and the old owner releases its lock
    const prepared = await prepareOpenAICodexRequest(createRequest(), {
      credentialPath,
      fetchImpl: async () =>
        jsonResponse(200, {
          access_token: newAccessToken,
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
    });

    // then: the new lock remains
    assert.equal(prepared.headers.Authorization, `Bearer ${newAccessToken}`);
    assert.equal(newOwnerCreated, true);
    const owner = await readLockOwner(lockPath);
    assert.equal(owner.id, "next-owner");
  });

  it("rejects a credential file accessible by other users", async (t) => {
    // given: a credential with loose permissions
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken(),
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600 * 1000,
    });
    await fs.chmod(credentialPath, 0o644);

    // when: preparing a request
    const preparation = prepareOpenAICodexRequest(createRequest(), {
      credentialPath,
    });

    // then: the unsafe file is not used
    await assert.rejects(preparation, /Unsafe permissions on credential file/);
  });
});

describe("logoutOpenAICodex", () => {
  it("deletes the credential and is idempotent", async (t) => {
    // given: a saved credential
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken(),
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600 * 1000,
    });

    // when: logging out twice
    const first = await logoutOpenAICodex({ credentialPath });
    const second = await logoutOpenAICodex({ credentialPath });

    // then: only the first logout deletes a file
    assert.equal(first, true);
    assert.equal(second, false);
    await assert.rejects(fs.stat(credentialPath), { code: "ENOENT" });
  });

  it("deletes temporary credentials left by a crash", async (t) => {
    // given: a credential and a temporary file using the atomic write naming scheme
    const directory = await createTempDirectory(t);
    const credentialPath = path.join(directory, "credential.json");
    await writeCredential(credentialPath, {
      accessToken: createAccessToken(),
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600 * 1000,
    });
    const temporaryPath = path.join(
      directory,
      ".credential.json.123.123e4567-e89b-42d3-a456-426614174000.tmp",
    );
    await fs.writeFile(temporaryPath, "sensitive-token", { mode: 0o600 });

    // when: logging out
    const deleted = await logoutOpenAICodex({ credentialPath });

    // then: both the published and temporary credentials are removed
    assert.equal(deleted, true);
    await assert.rejects(fs.stat(credentialPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(temporaryPath), { code: "ENOENT" });
  });
});

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {string} type
 * @returns {Promise<any>}
 */
function waitForChildMessage(child, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
    };
    /** @param {any} message */
    const onMessage = (message) => {
      if (message?.type !== type) {
        return;
      }
      cleanup();
      resolve(message);
    };
    /** @param {Error} error */
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.on("message", onMessage);
    child.on("error", onError);
  });
}

/**
 * @param {string} lockPath
 */
async function readLockOwner(lockPath) {
  const entries = await fs.readdir(lockPath);
  assert.equal(entries.length, 1);
  return JSON.parse(await fs.readFile(path.join(lockPath, entries[0]), "utf8"));
}

/**
 * @param {import("node:test").TestContext} t
 */
async function createTempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "plain-agent-openai-codex-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * @param {string} credentialPath
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} credential
 */
async function writeCredential(credentialPath, credential) {
  await fs.mkdir(path.dirname(credentialPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(credentialPath, JSON.stringify(credential), {
    mode: 0o600,
  });
}

/**
 * @param {number} status
 * @param {unknown} body
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param {string} [accountId]
 * @param {string} [marker]
 */
function createAccessToken(accountId = "account-1", marker = "marker") {
  const encode = (/** @type {unknown} */ value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    marker,
  })}.signature`;
}

/** @returns {import("../openaiResponses").OpenAIRequest} */
function createRequest() {
  return {
    model: "gpt-test",
    reasoning: { effort: "medium", summary: "auto" },
    input: [],
    stream: true,
  };
}
