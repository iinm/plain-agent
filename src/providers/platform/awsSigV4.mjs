import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} AwsCredentials
 */

// --- INI parser ---

/**
 * @param {string} text
 * @returns {Record<string, Record<string, string>>}
 */
function parseIni(text) {
  /** @type {Record<string, Record<string, string>>} */
  const sections = {};
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      sections[current] ??= {};
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex !== -1 && current) {
      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim();
      sections[current][key] = value;
    }
  }
  return sections;
}

// --- Credential loading ---

/**
 * @param {string} profile
 * @returns {Promise<Record<string, string>>}
 */
async function readProfileConfig(profile) {
  const configPath = join(
    process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config"),
  );
  const configText = await readFile(configPath, "utf-8").catch(() => "");
  const config = parseIni(configText);
  // In ~/.aws/config, sections are "[profile name]" except "[default]"
  return config[`profile ${profile}`] || config[profile] || {};
}

/**
 * @param {string} profile
 * @returns {Promise<Record<string, string>>}
 */
async function readProfileCredentials(profile) {
  const credPath = join(
    process.env.AWS_SHARED_CREDENTIALS_FILE ||
      join(homedir(), ".aws", "credentials"),
  );
  const credText = await readFile(credPath, "utf-8").catch(() => "");
  const creds = parseIni(credText);
  return creds[profile] || {};
}

/**
 * @param {string} sessionName
 * @returns {Promise<Record<string, string>>}
 */
async function readSsoSessionConfig(sessionName) {
  const configPath = join(
    process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config"),
  );
  const configText = await readFile(configPath, "utf-8").catch(() => "");
  const config = parseIni(configText);
  return config[`sso-session ${sessionName}`] || {};
}

/**
 * @param {string} key - sso_session name or sso_start_url
 * @returns {Promise<{ accessToken: string, region?: string } | undefined>}
 */
async function readSsoCachedToken(key) {
  const cacheDir = join(homedir(), ".aws", "sso", "cache");
  const hash = createHash("sha1").update(key, "utf-8").digest("hex");
  const cachePath = join(cacheDir, `${hash}.json`);
  try {
    const data = JSON.parse(await readFile(cachePath, "utf-8"));
    if (data.accessToken) {
      return { accessToken: data.accessToken, region: data.region };
    }
  } catch {
    // Cache file not found or invalid
  }
  return undefined;
}

/**
 * @param {{ accessToken: string, accountId: string, roleName: string, region: string }} params
 * @returns {Promise<AwsCredentials>}
 */
async function getSsoRoleCredentials({
  accessToken,
  accountId,
  roleName,
  region,
}) {
  const url = `https://portal.sso.${region}.amazonaws.com/federation/credentials?account_id=${encodeURIComponent(accountId)}&role_name=${encodeURIComponent(roleName)}`;
  const response = await fetch(url, {
    headers: { "x-amz-sso_bearer_token": accessToken },
    signal: AbortSignal.timeout(30 * 1000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `SSO GetRoleCredentials failed (${response.status}): ${text}`,
    );
  }
  const data = await response.json();
  const rc = data.roleCredentials;
  return {
    accessKeyId: rc.accessKeyId,
    secretAccessKey: rc.secretAccessKey,
    ...(rc.sessionToken && { sessionToken: rc.sessionToken }),
  };
}

/**
 * Load AWS credentials for the given profile from ~/.aws/config and ~/.aws/credentials.
 * Supports static credentials and SSO profiles.
 * @param {string} profile
 * @returns {Promise<AwsCredentials>}
 */
export async function loadAwsCredentials(profile) {
  const creds = await readProfileCredentials(profile);

  // Static credentials in ~/.aws/credentials
  if (creds.aws_access_key_id && creds.aws_secret_access_key) {
    return {
      accessKeyId: creds.aws_access_key_id,
      secretAccessKey: creds.aws_secret_access_key,
      ...(creds.aws_session_token && {
        sessionToken: creds.aws_session_token,
      }),
    };
  }

  const config = await readProfileConfig(profile);

  // Static credentials in ~/.aws/config
  if (config.aws_access_key_id && config.aws_secret_access_key) {
    return {
      accessKeyId: config.aws_access_key_id,
      secretAccessKey: config.aws_secret_access_key,
      ...(config.aws_session_token && {
        sessionToken: config.aws_session_token,
      }),
    };
  }

  // SSO profile (new format with sso_session)
  if (config.sso_session) {
    const session = await readSsoSessionConfig(config.sso_session);
    const ssoRegion = session.sso_region || config.sso_region;
    if (!ssoRegion) {
      throw new Error(`No sso_region found for profile "${profile}"`);
    }

    // Try cache key by session name first, then by start_url
    const token =
      (await readSsoCachedToken(config.sso_session)) ||
      (session.sso_start_url
        ? await readSsoCachedToken(session.sso_start_url)
        : undefined);

    if (!token) {
      throw new Error(
        `No SSO cached token found for profile "${profile}". Run "aws sso login --profile ${profile}" first.`,
      );
    }

    return getSsoRoleCredentials({
      accessToken: token.accessToken,
      accountId: config.sso_account_id,
      roleName: config.sso_role_name,
      region: ssoRegion,
    });
  }

  // SSO profile (legacy format without sso_session)
  if (config.sso_start_url && config.sso_account_id && config.sso_role_name) {
    const ssoRegion = config.sso_region;
    if (!ssoRegion) {
      throw new Error(`No sso_region found for profile "${profile}"`);
    }

    const token = await readSsoCachedToken(config.sso_start_url);
    if (!token) {
      throw new Error(
        `No SSO cached token found for profile "${profile}". Run "aws sso login --profile ${profile}" first.`,
      );
    }

    return getSsoRoleCredentials({
      accessToken: token.accessToken,
      accountId: config.sso_account_id,
      roleName: config.sso_role_name,
      region: ssoRegion,
    });
  }

  throw new Error(
    `No credentials found for profile "${profile}". Check ~/.aws/credentials and ~/.aws/config.`,
  );
}

// --- SigV4 signing ---

/**
 * @param {string} data
 * @returns {string}
 */
function sha256Hex(data) {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/**
 * @param {string | Buffer} key
 * @param {string} data
 * @returns {Buffer}
 */
function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data, "utf-8").digest();
}

/**
 * Sign an HTTP request with AWS Signature V4.
 *
 * @param {{
 *   method: string,
 *   hostname: string,
 *   path: string,
 *   headers: Record<string, string>,
 *   body: string,
 * }} request
 * @param {{
 *   region: string,
 *   service: string,
 *   credentials: AwsCredentials,
 * }} options
 * @returns {{ method: string, headers: Record<string, string>, body: string }}
 */
export function signRequest(request, options) {
  const { method, hostname, path, headers, body } = request;
  const { region, service, credentials } = options;

  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  /** @type {Record<string, string>} */
  const signedHeaders = { ...headers, host: hostname, "x-amz-date": amzDate };
  if (credentials.sessionToken) {
    signedHeaders["x-amz-security-token"] = credentials.sessionToken;
  }

  // Canonical headers: sorted, lowercased, trimmed
  const sortedKeys = Object.keys(signedHeaders)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = sortedKeys
    .map((k) => {
      const original = Object.keys(signedHeaders).find(
        (h) => h.toLowerCase() === k,
      );
      return `${k}:${signedHeaders[/** @type {string} */ (original)].trim()}`;
    })
    .join("\n");
  const signedHeadersList = sortedKeys.join(";");

  const payloadHash = sha256Hex(body || "");

  const canonicalRequest = [
    method,
    path,
    "", // query string (empty for POST)
    `${canonicalHeaders}\n`,
    signedHeadersList,
    payloadHash,
  ].join("\n");

  // String to sign
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // Signing key
  const kDate = hmacSha256(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");

  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf-8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  return {
    method,
    headers: { ...signedHeaders, Authorization: authorization },
    body,
  };
}
