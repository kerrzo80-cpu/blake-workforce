import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { workforceSigningKey } from "./signing-configuration.js";
test("rejects absent, empty, short, whitespace-altered and known-public signing configurations without reflecting their value", () => {
  for (const value of [
    undefined,
    "",
    "short-private-value",
    "development-only-secret-change-before-deploy",
    " " + "a".repeat(64),
    "a".repeat(64) + "\n",
  ])
    assert.throws(
      () => workforceSigningKey(value),
      (error) =>
        error instanceof Error &&
        error.message ===
          "WORKFORCE_JWT_SECRET must be configured with a private signing key of at least 32 bytes.",
    );
});
test("preserves the exact managed key bytes and validates an already-issued token without rotating or changing its identity", async () => {
  const value = randomBytes(48).toString("base64url"),
    original = new TextEncoder().encode(value);
  const token = await new SignJWT({
    tokenType: "access",
    organisationId: "isolated-company",
    email: "synthetic@example.test",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("isolated-account")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(original);
  assert.deepEqual(workforceSigningKey(value), original);
  const verified = await jwtVerify(token, workforceSigningKey(value), {
    algorithms: ["HS256"],
  });
  assert.equal(verified.payload.sub, "isolated-account");
  assert.equal(verified.payload.organisationId, "isolated-company");
});
