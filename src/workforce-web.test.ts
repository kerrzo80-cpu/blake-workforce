import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  mkdtemp,
  cp,
  readFile,
  writeFile,
  symlink,
  unlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkforceWeb } from "./workforce-web.js";
const options = {
  enabled: "true",
  officeOrigin: "https://blake-ewg-development.onrender.com",
  environment: "development",
  gatewayCommit: "a".repeat(40),
  backendUrl: "https://keen-narwhal-675.eu-west-1.convex.site",
};
test("serves the maintained public web release with same-origin API, explicit Development binding and no private configuration", async () => {
  const app = Fastify();
  try {
    assert.equal(await registerWorkforceWeb(app, options), true);
    const home = await app.inject({ method: "GET", url: "/" });
    assert.equal(home.statusCode, 200);
    assert.match(home.headers["content-type"]!, /text\/html/);
    assert.match(home.body, /Blake Workforce/);
    const config = await app.inject({
      method: "GET",
      url: "/config.js?v=existing-client-version",
    });
    assert.equal(config.statusCode, 200);
    assert.match(config.body, /export const API = ""/);
    assert.match(config.body, /ENVIRONMENT = "development"/);
    assert.match(config.body, /https:\/\/blake-ewg-development.onrender.com/);
    assert.doesNotMatch(
      config.body,
      /insightful|staging-api|JWT|SECRET|Bearer|refreshToken/,
    );
    const manifest = (
      await app.inject({ method: "GET", url: "/workforce-web-release.json" })
    ).json();
    assert.equal(
      manifest.sourceCommit,
      "64ada9902d9e25fea0d21547ecd8fd4022989bf0",
    );
    assert.equal(manifest.gatewayCommit, "a".repeat(40));
    assert.equal(
      manifest.backendHost,
      "keen-narwhal-675.eu-west-1.convex.site",
    );
    assert.equal(manifest.api, "same-origin");
    assert.equal(manifest.files.length, 13);
    for (const asset of manifest.files) {
      const result = await app.inject({
        method: "GET",
        url: "/" + asset.name + "?v=normal-client-version",
      });
      assert.equal(result.statusCode, 200);
      assert.equal(result.rawPayload.length, asset.bytes);
      assert.equal(result.headers["cache-control"], "no-store");
      assert.equal(result.headers["x-content-type-options"], "nosniff");
      assert.equal(result.headers["referrer-policy"], "no-referrer");
      assert.match(
        result.headers["content-security-policy"]!,
        /frame-ancestors 'none'/,
      );
      assert.match(
        result.headers["content-security-policy"]!,
        /connect-src 'self'/,
      );
    }
  } finally {
    await app.close();
  }
});
test("does not expose web routes when omitted, false or malformed, leaving the API root available for its original handler", async () => {
  for (const enabled of [undefined, "false", "1", "TRUE"]) {
    const app = Fastify();
    try {
      assert.equal(
        await registerWorkforceWeb(app, { ...options, enabled }),
        false,
      );
      app.get("/", async () => ({ service: "original-api" }));
      assert.equal((await app.inject("/")).json().service, "original-api");
      assert.equal((await app.inject("/config.js")).statusCode, 404);
    } finally {
      await app.close();
    }
  }
});
test("holds invalid or incomplete explicit environment settings before exposing any web route", async () => {
  for (const change of [
    { officeOrigin: undefined },
    { officeOrigin: "http://office.example.test" },
    { officeOrigin: "https://user:password@office.example.test" },
    { officeOrigin: "https://office.example.test/?private=secret" },
    { officeOrigin: "https://office.example.test/path" },
    { environment: undefined },
    { environment: "staging" },
    { backendUrl: "https://private:secret@backend.example.test" },
    { backendUrl: "http://public-backend.example.test" },
  ]) {
    const app = Fastify();
    try {
      await assert.rejects(
        registerWorkforceWeb(app, { ...options, ...change }),
      );
      assert.equal((await app.inject("/config.js")).statusCode, 404);
    } finally {
      await app.close();
    }
  }
});
test("has no arbitrary file, private folder, SPA fallback, remote proxy or financial endpoint", async () => {
  const app = Fastify();
  try {
    await registerWorkforceWeb(app, options);
    for (const url of [
      "/.env",
      "/src/server.ts",
      "/node_modules/package.json",
      "/release.json",
      "/web-release/release.json",
      "/web-release/config.js",
      "/auth",
      "/unknown-page",
      "/config.js/private",
      "/files/%2e%2e/%2eenv",
      "/%2eenv",
      "/%2fetc%2fpasswd",
      "/https://evil.invalid",
    ])
      assert.equal(
        (await app.inject({ method: "GET", url })).statusCode,
        404,
        url,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/",
          payload: { anything: "private" },
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});
test("fails startup on altered, duplicate, missing, unsafe or symlinked packaged assets instead of serving them", async () => {
  for (const kind of ["altered", "duplicate", "missing", "unsafe", "symlink"]) {
    const directory = await mkdtemp(join(tmpdir(), "blake-public-web-proof-"));
    const app = Fastify();
    try {
      await cp(new URL("../web-release/", import.meta.url), directory, {
        recursive: true,
      });
      const manifestFile = join(directory, "release.json"),
        manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      if (kind === "altered")
        await writeFile(join(directory, "app.js"), "altered");
      if (kind === "duplicate") manifest.files[1] = { ...manifest.files[0] };
      if (kind === "missing") manifest.files.pop();
      if (kind === "unsafe") manifest.files[1].name = "../private";
      if (kind === "symlink") {
        await unlink(join(directory, "app.js"));
        await symlink(join(directory, "styles.css"), join(directory, "app.js"));
      }
      await writeFile(manifestFile, JSON.stringify(manifest));
      await assert.rejects(
        registerWorkforceWeb(app, { ...options, releaseDirectory: directory }),
      );
      assert.equal((await app.inject("/config.js")).statusCode, 404);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
