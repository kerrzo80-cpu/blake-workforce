import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Fastify from "fastify";

const require = createRequire(import.meta.url);
// Exercise both installed branches rather than relying on an audit count.
for (const [name, load] of [
  ["gateway URI parser", () => require("fast-uri")],
  ["AJV URI parser", () => createRequire(require.resolve("ajv"))("fast-uri")],
] as const) {
  test(`${name} does not turn an encoded scheme into executable javascript`, () => {
    const uri = load();
    for (const input of ["%6Aavascript:alert(1)", "%u006Aavascript:alert(1)"]) {
      assert.notEqual(uri.parse(input).scheme, "javascript");
      assert.notEqual(uri.normalize(input), "javascript:alert(1)");
    }
    assert.equal(uri.parse("https://example.test/path").scheme, "https");
  });
}

test("Fastify applies mixed-case header-name restrictions before the handler", async () => {
  const app = Fastify();
  let reached = 0;
  app.get("/synthetic-security-check", {
    schema: { headers: { type: "object", propertyNames: { not: { enum: ["X-Debug-Override"] } } } },
  }, async () => { reached++; return { ok: true }; });
  try {
    const rejected = await app.inject({ method: "GET", url: "/synthetic-security-check", headers: { "X-Debug-Override": "synthetic" } });
    assert.equal(rejected.statusCode, 400);
    assert.equal(reached, 0);
    const ordinary = await app.inject({ method: "GET", url: "/synthetic-security-check" });
    assert.equal(ordinary.statusCode, 200);
    assert.equal(reached, 1);
  } finally { await app.close(); }
});
