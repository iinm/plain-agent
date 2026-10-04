/**
 * Build a masker that replaces every occurrence of the given secrets,
 * including common encoded variants, with a placeholder. Variants are replaced
 * longest-first so a shorter variant that is a substring of a longer one does
 * not leave a partially masked remainder.
 * @param {Record<string, string> | undefined} secrets
 * @returns {(text: string) => string}
 */
export function createSecretMasker(secrets) {
  const variants = [
    ...new Set(
      Object.values(secrets ?? {})
        .filter((secret) => typeof secret === "string" && secret.length > 0)
        .flatMap((secret) => [
          secret,
          Buffer.from(secret, "utf8").toString("base64"),
          Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, ""),
          Buffer.from(secret, "utf8").toString("base64url"),
          Buffer.from(secret, "utf8").toString("hex"),
          Buffer.from(secret, "utf8").toString("hex").toUpperCase(),
          encodeURIComponent(secret),
          encodeURI(secret),
          JSON.stringify(secret).slice(1, -1),
          secret.replace(/ /g, "+"),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);

  return (text) => {
    let masked = text;
    for (const variant of variants) {
      masked = masked.replaceAll(variant, "***");
    }
    return masked;
  };
}
