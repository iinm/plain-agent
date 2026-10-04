/**
 * Create a function that replaces every occurrence of the given secret values
 * (and common encoded forms of them) with "***".
 *
 * The returned function is pure and idempotent, so it is safe to apply more
 * than once. Secrets are matched longest-first so that a secret contained in
 * another secret is masked as a whole.
 *
 * @param {Record<string, string> | undefined} [secrets]
 * @returns {((text: string) => string) | undefined}
 *   undefined when there is no non-empty secret to mask.
 */
export function createSecretMasker(secrets) {
  /** @type {Set<string>} */
  const variants = new Set();
  for (const secret of Object.values(secrets ?? {})) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    for (const variant of expandSecretVariants(secret)) {
      if (variant.length > 0) variants.add(variant);
    }
  }

  if (variants.size === 0) return undefined;

  const ordered = [...variants].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((acc, v) => acc.replaceAll(v, "***"), text);
}

/**
 * @param {string} secret
 * @returns {string[]}
 */
function expandSecretVariants(secret) {
  const base64 = Buffer.from(secret, "utf8").toString("base64");
  return [
    secret,
    base64,
    base64.replace(/=+$/, ""),
    Buffer.from(secret, "utf8").toString("base64url"),
    encodeURIComponent(secret),
    encodeURI(secret),
    JSON.stringify(secret).slice(1, -1),
    secret.replace(/ /g, "+"),
  ];
}
