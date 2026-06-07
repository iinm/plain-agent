/**
 * Purge Camo cache for README badge images.
 *
 * Usage: node scripts/purgeBadgeCache.mjs
 *
 * Fetches the rendered README from the GitHub API, extracts badge image URLs
 * proxied through Camo (camo.githubusercontent.com), and sends PURGE requests
 * to clear the cache.
 *
 * Set GITHUB_TOKEN to avoid rate limits on the GitHub API.
 *
 * Ref: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls#removing-an-image-from-camos-cache
 */

const REPO = "iinm/plain-agent";

async function main() {
  const camoUrls = await fetchCamoUrls();
  if (camoUrls.length === 0) {
    console.error("No Camo URLs found in the rendered README.");
    return;
  }

  console.error(`Found ${camoUrls.length} Camo URL(s):`);
  for (const url of camoUrls) {
    console.error(`  ${url}`);
  }

  const results = await purgeAll(camoUrls);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} PURGE request(s) failed.`);
    process.exit(1);
  }
  console.error("\nAll PURGE requests succeeded.");
}

async function fetchCamoUrls() {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/vnd.github.html+json" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/readme`, {
    headers,
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch README: HTTP ${res.status}`);
  }
  const html = await res.text();

  return [
    ...new Set(
      [
        ...html.matchAll(/https:\/\/camo\.githubusercontent\.com\/[^"'\s)]+/g),
      ].map((m) => m[0]),
    ),
  ];
}

/** @param {string[]} urls */
async function purgeAll(urls) {
  const results = [];
  for (const url of urls) {
    const res = await fetch(url, { method: "PURGE" });
    const body = await res.text();
    const ok = res.ok;
    console.error(`PURGE ${url}`);
    console.error(`  ${res.status} ${body}`);
    results.push({ url, ok });
  }
  return results;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
