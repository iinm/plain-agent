import { execFile } from "node:child_process";

/**
 * Google Cloud access tokens issued by `gcloud auth print-access-token` last
 * about 1 hour. Cache them slightly shorter to keep a safety margin before
 * actual expiry.
 */
const TOKEN_TTL_MS = 55 * 60 * 1000;

/** @type {Map<string, { token: string, expiresAt: number }>} */
const tokenCache = new Map();

/**
 * @param {string=} account
 * @returns {Promise<string>}
 */
export async function getGoogleCloudAccessToken(account) {
  const cacheKey = account ?? "";
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const accountOption = account?.endsWith("iam.gserviceaccount.com")
    ? ["--impersonate-service-account", account]
    : account
      ? [account]
      : [];

  /** @type {string} */
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      "gcloud",
      ["auth", "print-access-token", ...accountOption],
      {
        shell: false,
        timeout: 10 * 1000,
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

  tokenCache.set(cacheKey, {
    token: stdout,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  return stdout;
}
