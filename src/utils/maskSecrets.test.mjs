import assert from "node:assert";
import { describe, it } from "node:test";
import { createSecretMasker } from "./maskSecrets.mjs";

describe("createSecretMasker", () => {
  it("masks the raw secret", () => {
    // given:
    const mask = createSecretMasker({ SECRET: "secret-value" });

    // when:
    const masked = mask("the secret-value is here");

    // then:
    assert.equal(masked, "the *** is here");
  });

  it("masks every encoded variant", () => {
    // given:
    const secret = '"p@ss word"';
    const mask = createSecretMasker({ SECRET: secret });
    const variants = [
      secret,
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64").replace(/=+$/, ""),
      Buffer.from(secret).toString("base64url"),
      Buffer.from(secret).toString("hex"),
      Buffer.from(secret).toString("hex").toUpperCase(),
      encodeURIComponent(secret),
      encodeURI(secret),
      JSON.stringify(secret).slice(1, -1),
      secret.replace(/ /g, "+"),
    ];

    // when:
    const masked = mask(variants.join("\n"));

    // then:
    assert.equal(masked, variants.map(() => "***").join("\n"));
  });

  it("masks longer variants before shorter substrings of them", () => {
    // given:
    const mask = createSecretMasker({ SHORT: "abc", LONG: "abcd" });

    // when:
    const masked = mask("abcd");

    // then:
    assert.equal(masked, "***");
  });

  it("leaves text unchanged when no secrets are configured", () => {
    // given:
    const mask = createSecretMasker(undefined);

    // when:
    const masked = mask("nothing to hide");

    // then:
    assert.equal(masked, "nothing to hide");
  });
});
