/**
 * Create a function that replaces every occurrence of the given secret values
 * (and common encoded forms of them) with "***".
 *
 * @param {Record<string, string>} secrets
 * @returns {(text: string) => string}
 */
export function createSecretMasker(secrets) {
  /** @type {Set<string>} */
  const variants = new Set();
  for (const secret of Object.values(secrets)) {
    if (secret.length === 0) continue;
    for (const variant of expandSecretVariants(secret)) {
      if (variant.length > 0) variants.add(variant);
    }
  }

  if (variants.size === 0) return (text) => text;

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
