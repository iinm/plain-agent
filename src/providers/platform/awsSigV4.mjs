import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";

/**
 * @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} AwsCredentials
 */

/**
 * Load AWS credentials for the given profile using the AWS CLI.
 * @param {string} profile
 * @returns {Promise<AwsCredentials>}
 */
export async function loadAwsCredentials(profile) {
  /** @type {string} */
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      "aws",
      [
        "configure",
        "export-credentials",
        "--profile",
        profile,
        "--format",
        "json",
      ],
      {
        shell: false,
        timeout: 30 * 1000,
      },
      (error, stdout, _stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
  const parsed = JSON.parse(stdout);
  return {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    ...(parsed.SessionToken && { sessionToken: parsed.SessionToken }),
  };
}

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
