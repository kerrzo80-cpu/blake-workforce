/** Keep existing configured HMAC bytes unchanged. Missing/public defaults must
 * never turn an authenticated gateway into one with a forgeable signing key. */
export function workforceSigningKey(value: string | undefined): Uint8Array {
  if (
    !value ||
    value.trim() !== value ||
    value === "development-only-secret-change-before-deploy" ||
    new TextEncoder().encode(value).byteLength < 32
  ) {
    throw new Error(
      "WORKFORCE_JWT_SECRET must be configured with a private signing key of at least 32 bytes.",
    );
  }
  return new TextEncoder().encode(value);
}
