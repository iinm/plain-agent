import assert from "node:assert";
import { describe, it } from "node:test";
import { createSecretMasker } from "./maskSecrets.mjs";

describe("createSecretMasker", () => {
  it("returns an identity function when there is no secret", () => {
    assert.equal(createSecretMasker({})("a b"), "a b");
    assert.equal(createSecretMasker({ EMPTY: "" })("x"), "x");
  });

  it("masks the plain secret", () => {
    // given:
    const mask = createSecretMasker({ SECRET: "secret-value" });

    // when:
    const result = mask("a secret-value b");

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
    const result = mask(input);

    // then:
    assert.equal(result, "*** *** *** *** *** ***");
  });

  it("masks a longer secret before a shorter secret it contains", () => {
    // given:
    const mask = createSecretMasker({ SHORT: "token", LONG: "token-extra" });

    // when:
    const result = mask("token-extra token");

    // then:
    assert.equal(result, "*** ***");
  });
});
