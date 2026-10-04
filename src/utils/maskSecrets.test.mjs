import assert from "node:assert";
import { describe, it } from "node:test";
import { createSecretMasker } from "./maskSecrets.mjs";

describe("createSecretMasker", () => {
  it("returns undefined when there is no secret to mask", () => {
    assert.equal(createSecretMasker({}), undefined);
    assert.equal(createSecretMasker({ EMPTY: "" }), undefined);
  });

  it("ignores non-string secret values", () => {
    // given: config values are typed as strings but come from user JSON
    const secrets = /** @type {Record<string, string>} */ (
      /** @type {unknown} */ ({ N: 123, S: "s3cr3t" })
    );

    // when:
    const mask = createSecretMasker(secrets);

    // then:
    assert.equal(mask?.("a s3cr3t b"), "a *** b");
    assert.equal(
      createSecretMasker(
        /** @type {Record<string, string>} */ (
          /** @type {unknown} */ ({ N: 1 })
        ),
      ),
      undefined,
    );
  });

  it("masks the plain secret", () => {
    // given:
    const mask = createSecretMasker({ SECRET: "secret-value" });

    // when:
    const result = mask?.("a secret-value b");

    // then:
    assert.equal(result, "a *** b");
  });

  it("masks encoded variants", () => {
    // given:
    const secret = "secret value";
    const mask = createSecretMasker({ SECRET: secret });
    const input = [
      secret,
      Buffer.from(secret, "utf8").toString("base64"),
      Buffer.from(secret, "utf8").toString("base64url"),
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
      secret.replace(/ /g, "+"),
    ].join(" ");

    // when:
    const result = mask?.(input);

    // then:
    assert.equal(result, "*** *** *** *** *** ***");
  });

  it("masks a longer secret before a shorter secret it contains", () => {
    // given:
    const mask = createSecretMasker({ SHORT: "token", LONG: "token-extra" });

    // when:
    const result = mask?.("token-extra token");

    // then:
    assert.equal(result, "*** ***");
  });

  it("is idempotent", () => {
    // given:
    const mask = createSecretMasker({ SECRET: "s3cr3t" });

    // when:
    const once = mask?.("a s3cr3t b") ?? "";
    const twice = mask?.(once) ?? "";

    // then:
    assert.equal(once, "a *** b");
    assert.equal(twice, once);
  });

  it("stays idempotent for a secret made only of asterisks", () => {
    // given: "*"-only variants are substrings of "***", so they are skipped
    const mask = createSecretMasker({ SECRET: "*" });

    // when:
    const once = mask?.("a*b") ?? "";
    const twice = mask?.(once) ?? "";

    // then:
    assert.equal(twice, once);
  });
});
