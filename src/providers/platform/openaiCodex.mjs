/**
 * @import { OpenAIRequest } from "../openaiResponses"
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_DATA_DIR } from "../../env.mjs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_AUTH_BASE_URL = "https://auth.openai.com";
const DEVICE_VERIFICATION_URL = `${DEFAULT_AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${DEFAULT_AUTH_BASE_URL}/deviceauth/callback`;
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_CREDENTIAL_PATH = path.join(
  AGENT_DATA_DIR,
  "credentials",
  "openai-codex.json",
);
const DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;
const LOCK_TIMEOUT_MS = 90 * 1000;
const STALE_LOCK_MS = 60 * 1000;
const LOCK_RETRY_MS = 100;
const MINIMUM_POLL_INTERVAL_MS = 1000;
const SLOW_DOWN_INCREMENT_MS = 5000;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** @type {Map<string, Promise<OpenAICodexCredential>>} */
const refreshTasks = new Map();

/**
 * @typedef {Object} OpenAICodexCredential
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt - Unix time in milliseconds.
 */

/**
 * @typedef {Object} OpenAICodexOptions
 * @property {string} [credentialPath]
 * @property {string} [authBaseURL]
 * @property {typeof fetch} [fetchImpl]
 * @property {() => number} [now]
 * @property {(milliseconds: number) => Promise<void>} [sleep]
 * @property {(pid: number) => boolean} [isProcessAlive]
 * @property {number} [deviceFlowTimeoutMs]
 * @property {number} [requestTimeoutMs]
 * @property {number} [refreshMarginMs]
 * @property {number} [lockTimeoutMs]
 * @property {number} [staleLockMs]
 * @property {number} [lockRetryMs]
 * @property {Record<string, string>} [customHeaders]
 */

/**
 * @typedef {Object} ResolvedOpenAICodexOptions
 * @property {string} credentialPath
 * @property {string} authBaseURL
 * @property {typeof fetch} fetchImpl
 * @property {() => number} now
 * @property {(milliseconds: number) => Promise<void>} sleep
 * @property {(pid: number) => boolean} isProcessAlive
 * @property {number} deviceFlowTimeoutMs
 * @property {number} requestTimeoutMs
 * @property {number} refreshMarginMs
 * @property {number} lockTimeoutMs
 * @property {number} staleLockMs
 * @property {number} lockRetryMs
 */

/**
 * @typedef {Object} DeviceCode
 * @property {string} deviceAuthId
 * @property {string} userCode
 * @property {number} intervalSeconds
 */

/**
 * @typedef {Object} CredentialLock
 * @property {string} id
 * @property {string} path
 */

/**
 * Authenticate with the ChatGPT Device Code Flow and save the credential.
 * The callback must display the verification URL and user code to the user.
 *
 * @param {OpenAICodexOptions & { onDeviceCode: (device: { verificationUrl: string, userCode: string, expiresInSeconds: number }) => void | Promise<void> }} options
 * @returns {Promise<void>}
 */
export async function loginOpenAICodex(options) {
  const resolved = resolveOptions(options);
  const device = await requestDeviceCode(resolved);
  await options.onDeviceCode({
    verificationUrl: DEVICE_VERIFICATION_URL,
    userCode: device.userCode,
    expiresInSeconds: Math.floor(resolved.deviceFlowTimeoutMs / 1000),
  });
  const authorization = await pollDeviceAuthorization(device, resolved);
  const credential = await exchangeAuthorizationCode(authorization, resolved);
  await withCredentialLock(resolved, async (lock) => {
    await writeCredential(credential, resolved, lock);
  });
}

/**
 * Delete the saved ChatGPT credential.
 *
 * @param {OpenAICodexOptions} [options]
 * @returns {Promise<boolean>} Whether a credential file was deleted.
 */
export async function logoutOpenAICodex(options = {}) {
  const resolved = resolveOptions(options);
  return await withCredentialLock(resolved, async (lock) => {
    await assertLockOwner(lock);
    let deleted = false;
    try {
      await fs.unlink(resolved.credentialPath);
      deleted = true;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    await removeTemporaryCredentials(resolved);
    return deleted;
  });
}

/**
 * Prepare a Responses API request for the ChatGPT Codex endpoint.
 * A valid access token is loaded from disk and refreshed when necessary.
 *
 * @param {OpenAIRequest} request
 * @param {OpenAICodexOptions} [options]
 * @returns {Promise<{ url: string, headers: Record<string, string>, body: string }>}
 */
export async function prepareOpenAICodexRequest(request, options = {}) {
  const resolved = resolveOptions(options);
  const credential = await getValidCredential(resolved);
  const accountId = extractAccountId(credential.accessToken);
  /** @type {OpenAIRequest & { max_output_tokens?: number, maxTokens?: number }} */
  const codexRequest = {
    ...request,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  delete codexRequest.max_output_tokens;
  delete codexRequest.maxTokens;

  const requiredHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    originator: "plain-agent",
  };
  const requiredHeaderNames = new Set(
    Object.keys(requiredHeaders).map((name) => name.toLowerCase()),
  );
  const customHeaders = Object.fromEntries(
    Object.entries(options.customHeaders ?? {}).filter(
      ([name]) => !requiredHeaderNames.has(name.toLowerCase()),
    ),
  );

  return {
    url: CODEX_RESPONSES_URL,
    headers: { ...customHeaders, ...requiredHeaders },
    body: JSON.stringify(codexRequest),
  };
}

/**
 * @param {OpenAICodexOptions} options
 * @returns {ResolvedOpenAICodexOptions}
 */
function resolveOptions(options) {
  return {
    credentialPath: options.credentialPath ?? DEFAULT_CREDENTIAL_PATH,
    authBaseURL: (options.authBaseURL ?? DEFAULT_AUTH_BASE_URL).replace(
      /\/$/,
      "",
    ),
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? defaultSleep,
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    deviceFlowTimeoutMs: options.deviceFlowTimeoutMs ?? DEVICE_FLOW_TIMEOUT_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    refreshMarginMs: options.refreshMarginMs ?? REFRESH_MARGIN_MS,
    lockTimeoutMs: options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    staleLockMs: options.staleLockMs ?? STALE_LOCK_MS,
    lockRetryMs: options.lockRetryMs ?? LOCK_RETRY_MS,
  };
}

/**
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<DeviceCode>}
 */
async function requestDeviceCode(options) {
  const response = await options.fetchImpl(
    `${options.authBaseURL}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(
      `OpenAI Codex device code request failed: status=${response.status}`,
    );
  }
  const json = await readJsonResponse(response, "device code");
  const intervalSeconds = parseInterval(json.interval);
  if (
    typeof json.device_auth_id !== "string" ||
    json.device_auth_id.length === 0 ||
    typeof json.user_code !== "string" ||
    json.user_code.length === 0 ||
    intervalSeconds === undefined
  ) {
    throw new Error("Invalid OpenAI Codex device code response");
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds,
  };
}

/**
 * @param {DeviceCode} device
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<{ authorizationCode: string, codeVerifier: string }>}
 */
async function pollDeviceAuthorization(device, options) {
  const deadline = options.now() + options.deviceFlowTimeoutMs;
  let intervalMs = Math.max(
    MINIMUM_POLL_INTERVAL_MS,
    Math.floor(device.intervalSeconds * 1000),
  );

  while (options.now() < deadline) {
    const result = await pollDeviceAuthorizationOnce(device, options);
    if (result.status === "complete") {
      return result.value;
    }
    if (result.status === "failed") {
      throw new Error(result.message);
    }
    if (result.status === "slow_down") {
      intervalMs = result.intervalSeconds
        ? Math.max(
            MINIMUM_POLL_INTERVAL_MS,
            Math.floor(result.intervalSeconds * 1000),
          )
        : intervalMs + SLOW_DOWN_INCREMENT_MS;
    }

    const remainingMs = deadline - options.now();
    if (remainingMs <= 0) {
      break;
    }
    await options.sleep(Math.min(intervalMs, remainingMs));
  }
  throw new Error("OpenAI Codex device authorization timed out");
}

/**
 * @param {DeviceCode} device
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<{ status: "pending" } | { status: "slow_down", intervalSeconds?: number } | { status: "failed", message: string } | { status: "complete", value: { authorizationCode: string, codeVerifier: string } }>}
 */
async function pollDeviceAuthorizationOnce(device, options) {
  const response = await options.fetchImpl(
    `${options.authBaseURL}/api/accounts/deviceauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    },
  );
  if (response.ok) {
    const json = await readJsonResponse(response, "device authorization");
    if (
      typeof json.authorization_code !== "string" ||
      json.authorization_code.length === 0 ||
      typeof json.code_verifier !== "string" ||
      json.code_verifier.length === 0
    ) {
      return {
        status: "failed",
        message: "Invalid OpenAI Codex device authorization response",
      };
    }
    return {
      status: "complete",
      value: {
        authorizationCode: json.authorization_code,
        codeVerifier: json.code_verifier,
      },
    };
  }
  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }

  const json = await readOptionalJsonResponse(response);
  const errorCode = readOAuthErrorCode(json);
  if (errorCode === "deviceauth_authorization_pending") {
    return { status: "pending" };
  }
  if (errorCode === "slow_down") {
    return {
      status: "slow_down",
      intervalSeconds: parseOptionalInterval(json?.interval),
    };
  }
  return {
    status: "failed",
    message: `OpenAI Codex device authorization failed: status=${response.status}`,
  };
}

/**
 * @param {{ authorizationCode: string, codeVerifier: string }} authorization
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<OpenAICodexCredential>}
 */
async function exchangeAuthorizationCode(authorization, options) {
  const response = await options.fetchImpl(
    `${options.authBaseURL}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authorization.authorizationCode,
        code_verifier: authorization.codeVerifier,
        redirect_uri: DEVICE_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    },
  );
  return await readTokenResponse(response, "exchange", options);
}

/**
 * @param {OpenAICodexCredential} credential
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<OpenAICodexCredential>}
 */
async function refreshAccessToken(credential, options) {
  const response = await options.fetchImpl(
    `${options.authBaseURL}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    },
  );
  return await readTokenResponse(
    response,
    "refresh",
    options,
    credential.refreshToken,
  );
}

/**
 * @param {Response} response
 * @param {"exchange" | "refresh"} operation
 * @param {ResolvedOpenAICodexOptions} options
 * @param {string} [fallbackRefreshToken]
 * @returns {Promise<OpenAICodexCredential>}
 */
async function readTokenResponse(
  response,
  operation,
  options,
  fallbackRefreshToken,
) {
  if (!response.ok) {
    throw new Error(
      `OpenAI Codex token ${operation} failed: status=${response.status}`,
    );
  }
  const json = await readJsonResponse(response, `token ${operation}`);
  const refreshToken = json.refresh_token ?? fallbackRefreshToken;
  if (
    typeof json.access_token !== "string" ||
    json.access_token.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    typeof json.expires_in !== "number" ||
    !Number.isFinite(json.expires_in) ||
    json.expires_in <= 0
  ) {
    throw new Error(`Invalid OpenAI Codex token ${operation} response`);
  }
  const credential = {
    accessToken: json.access_token,
    refreshToken,
    expiresAt: options.now() + json.expires_in * 1000,
  };
  extractAccountId(credential.accessToken);
  return credential;
}

/**
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<OpenAICodexCredential>}
 */
async function getValidCredential(options) {
  const credential = await readCredential(options);
  if (!credential) {
    throw new Error(
      'ChatGPT credential not found. Run "plain auth login openai-codex" first.',
    );
  }
  if (isCredentialValid(credential, options)) {
    return credential;
  }
  return await refreshCredentialSingleFlight(options);
}

/**
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<OpenAICodexCredential>}
 */
async function refreshCredentialSingleFlight(options) {
  const key = path.resolve(options.credentialPath);
  const existingTask = refreshTasks.get(key);
  if (existingTask) {
    return await existingTask;
  }

  const task = withCredentialLock(options, async (lock) => {
    const latest = await readCredential(options);
    if (!latest) {
      throw new Error(
        'ChatGPT credential not found. Run "plain auth login openai-codex" first.',
      );
    }
    if (isCredentialValid(latest, options)) {
      return latest;
    }
    const refreshed = await refreshAccessToken(latest, options);
    await writeCredential(refreshed, options, lock);
    return refreshed;
  });
  refreshTasks.set(key, task);
  try {
    return await task;
  } finally {
    if (refreshTasks.get(key) === task) {
      refreshTasks.delete(key);
    }
  }
}

/**
 * @param {OpenAICodexCredential} credential
 * @param {ResolvedOpenAICodexOptions} options
 */
function isCredentialValid(credential, options) {
  return credential.expiresAt > options.now() + options.refreshMarginMs;
}

/**
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<OpenAICodexCredential | undefined>}
 */
async function readCredential(options) {
  try {
    await assertSecureDirectory(path.dirname(options.credentialPath));
    const stat = await fs.lstat(options.credentialPath);
    assertCredentialFile(stat, options.credentialPath, true);
    const text = await fs.readFile(options.credentialPath, "utf8");
    const json = JSON.parse(text);
    if (
      typeof json?.accessToken !== "string" ||
      json.accessToken.length === 0 ||
      typeof json?.refreshToken !== "string" ||
      json.refreshToken.length === 0 ||
      typeof json?.expiresAt !== "number" ||
      !Number.isFinite(json.expiresAt)
    ) {
      throw new Error("Invalid OpenAI Codex credential file");
    }
    return {
      accessToken: json.accessToken,
      refreshToken: json.refreshToken,
      expiresAt: json.expiresAt,
    };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error("Invalid OpenAI Codex credential file");
    }
    throw error;
  }
}

/**
 * @param {OpenAICodexCredential} credential
 * @param {ResolvedOpenAICodexOptions} options
 * @param {CredentialLock} lock
 */
async function writeCredential(credential, options, lock) {
  await assertLockOwner(lock);
  const directory = path.dirname(options.credentialPath);
  await assertSecureDirectory(directory);
  try {
    const existingStat = await fs.lstat(options.credentialPath);
    assertCredentialFile(existingStat, options.credentialPath, false);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  const temporaryPath = path.join(
    directory,
    `.${path.basename(options.credentialPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  /** @type {fs.FileHandle | undefined} */
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertLockOwner(lock);
    await fs.rename(temporaryPath, options.credentialPath);
  } catch (error) {
    if (handle) {
      await handle.close();
    }
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * @param {ResolvedOpenAICodexOptions} options
 */
async function removeTemporaryCredentials(options) {
  const directory = path.dirname(options.credentialPath);
  const prefix = `.${path.basename(options.credentialPath)}.`;
  const entries = await fs.readdir(directory);
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) {
      continue;
    }
    const suffix = entry.slice(prefix.length, -".tmp".length);
    if (!/^\d+\.[0-9a-f-]{36}$/.test(suffix)) {
      continue;
    }
    try {
      await fs.unlink(path.join(directory, entry));
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

/**
 * @template T
 * @param {ResolvedOpenAICodexOptions} options
 * @param {(lock: CredentialLock) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withCredentialLock(options, callback) {
  await ensureSecureDirectory(path.dirname(options.credentialPath));
  const lock = await acquireCredentialLock(options);
  try {
    return await callback(lock);
  } finally {
    await releaseCredentialLock(lock);
  }
}

/**
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<CredentialLock>}
 */
async function acquireCredentialLock(options) {
  const lockPath = `${options.credentialPath}.lock`;
  const startedAt = options.now();
  while (true) {
    if (!(await pathExists(lockPath))) {
      const lock = { id: randomUUID(), path: lockPath };
      const candidatePath = `${lockPath}.candidate.${process.pid}.${lock.id}`;
      try {
        await fs.mkdir(candidatePath, { mode: 0o700 });
        await fs.writeFile(
          path.join(candidatePath, lockOwnerFileName(lock.id)),
          JSON.stringify({
            id: lock.id,
            pid: process.pid,
            createdAt: options.now(),
          }),
          { flag: "wx", mode: 0o600 },
        );
        try {
          await fs.rename(candidatePath, lockPath);
          return lock;
        } catch (error) {
          if (
            !isErrorCode(error, "EEXIST") &&
            !isErrorCode(error, "ENOTEMPTY")
          ) {
            throw error;
          }
        }
      } finally {
        await fs.rm(candidatePath, { recursive: true, force: true });
      }
    }

    if (await tryReclaimStaleCredentialLock(lockPath, options)) {
      continue;
    }
    const elapsedMs = options.now() - startedAt;
    if (elapsedMs >= options.lockTimeoutMs) {
      throw new Error("Timed out waiting for the OpenAI Codex credential lock");
    }
    await options.sleep(
      Math.min(options.lockRetryMs, options.lockTimeoutMs - elapsedMs),
    );
  }
}

/**
 * @param {string} lockPath
 * @param {ResolvedOpenAICodexOptions} options
 * @returns {Promise<boolean>} Whether lock acquisition should be retried immediately.
 */
async function tryReclaimStaleCredentialLock(lockPath, options) {
  const snapshot = await readLockSnapshot(lockPath);
  if (!snapshot) {
    return true;
  }
  const createdAt = snapshot.owner?.createdAt ?? snapshot.mtimeMs;
  const isStale = snapshot.owner
    ? !options.isProcessAlive(snapshot.owner.pid)
    : options.now() - createdAt >= options.staleLockMs;
  if (!isStale) {
    return false;
  }

  await removeLockSnapshot(lockPath, snapshot.entries);
  return true;
}

/**
 * @param {CredentialLock} lock
 */
async function releaseCredentialLock(lock) {
  const snapshot = await readLockSnapshot(lock.path);
  if (!snapshot) {
    return;
  }
  if (snapshot.owner?.id !== lock.id) {
    throw new Error("OpenAI Codex credential lock ownership was lost");
  }

  await removeLockSnapshot(lock.path, [lockOwnerFileName(lock.id)]);
}

/**
 * @param {CredentialLock} lock
 */
async function assertLockOwner(lock) {
  const snapshot = await readLockSnapshot(lock.path);
  if (snapshot?.owner?.id !== lock.id) {
    throw new Error("OpenAI Codex credential lock ownership was lost");
  }
}

/**
 * @param {string} id
 */
function lockOwnerFileName(id) {
  return `owner-${id}.json`;
}

/**
 * @param {string} lockPath
 * @returns {Promise<{ entries: string[], mtimeMs: number, owner: { id: string, pid: number, createdAt: number } | undefined } | undefined>}
 */
async function readLockSnapshot(lockPath) {
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory()) {
      throw new Error("Invalid OpenAI Codex credential lock");
    }
    const entries = await fs.readdir(lockPath);
    let rawOwner;
    if (entries.length === 1) {
      try {
        rawOwner = await fs.readFile(path.join(lockPath, entries[0]), "utf8");
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
    const json = rawOwner ? parseJsonOrUndefined(rawOwner) : undefined;
    const owner =
      typeof json?.id === "string" &&
      Number.isInteger(json?.pid) &&
      json.pid > 0 &&
      typeof json?.createdAt === "number" &&
      Number.isFinite(json.createdAt)
        ? { id: json.id, pid: json.pid, createdAt: json.createdAt }
        : undefined;
    return {
      entries,
      mtimeMs: stat.mtimeMs,
      owner,
    };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/**
 * @param {string} lockPath
 * @param {string[]} entries
 */
async function removeLockSnapshot(lockPath, entries) {
  for (const entry of entries) {
    try {
      await fs.unlink(path.join(lockPath, entry));
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  try {
    await fs.rmdir(lockPath);
  } catch (error) {
    if (
      !isErrorCode(error, "ENOENT") &&
      !isErrorCode(error, "ENOTEMPTY") &&
      !isErrorCode(error, "EEXIST")
    ) {
      throw error;
    }
  }
}

/**
 * @param {string} directory
 */
async function ensureSecureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  assertSecureDirectoryStat(stat, directory);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    await fs.chmod(directory, 0o700);
  }
}

/**
 * @param {string} directory
 */
async function assertSecureDirectory(directory) {
  const stat = await fs.lstat(directory);
  assertSecureDirectoryStat(stat, directory);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    throw new Error(`Unsafe permissions on credential directory: ${directory}`);
  }
}

/**
 * @param {import("node:fs").Stats} stat
 * @param {string} directory
 */
function assertSecureDirectoryStat(stat, directory) {
  if (!stat.isDirectory()) {
    throw new Error(`Invalid credential directory: ${directory}`);
  }
  assertOwner(stat, directory);
}

/**
 * @param {import("node:fs").Stats} stat
 * @param {string} filePath
 * @param {boolean} checkMode
 */
function assertCredentialFile(stat, filePath, checkMode) {
  if (!stat.isFile()) {
    throw new Error(`Invalid credential file: ${filePath}`);
  }
  assertOwner(stat, filePath);
  if (
    checkMode &&
    process.platform !== "win32" &&
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(`Unsafe permissions on credential file: ${filePath}`);
  }
}

/**
 * @param {import("node:fs").Stats} stat
 * @param {string} filePath
 */
function assertOwner(stat, filePath) {
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`Credential is not owned by the current user: ${filePath}`);
  }
}

/**
 * @param {string} accessToken
 * @returns {string}
 */
function extractAccountId(accessToken) {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT");
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new Error("Missing account ID");
    }
    return accountId;
  } catch {
    throw new Error(
      "Failed to extract the ChatGPT account ID from access token",
    );
  }
}

/**
 * @param {Response} response
 * @param {string} operation
 * @returns {Promise<Record<string, any>>}
 */
async function readJsonResponse(response, operation) {
  try {
    const json = await response.json();
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new Error("Invalid JSON object");
    }
    return json;
  } catch {
    throw new Error(`Invalid OpenAI Codex ${operation} response`);
  }
}

/**
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function readOptionalJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * @param {any} json
 * @returns {string | undefined}
 */
function readOAuthErrorCode(json) {
  const error = json?.error;
  if (typeof error === "string") {
    return error;
  }
  return typeof error?.code === "string" ? error.code : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function parseInterval(value) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * @param {unknown} value
 */
function parseOptionalInterval(value) {
  const parsed = parseInterval(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

/**
 * @param {string} text
 */
function parseJsonOrUndefined(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} error
 * @param {string} code
 */
function isErrorCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/**
 * @param {string} filePath
 */
async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/**
 * @param {number} pid
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

/**
 * @param {number} milliseconds
 */
async function defaultSleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
