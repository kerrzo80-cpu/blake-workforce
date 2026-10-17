import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SignJWT } from "jose";

test("existing company-scoped sessions survive a second company login without changing tenant or revocation", async () => {
  const secret = randomBytes(32).toString("hex"), syncSecret = randomBytes(32).toString("hex"), password = randomBytes(24).toString("hex");
  const email = "multi-company@example.test";
  let selected = "A", revokedA = false;
  const provisioned = new Set<string>();
  const authenticationCalls: Array<Record<string, unknown>> = [];
  const account = (company: string) => ({ id: `account-${company}`, email, passwordHash: "unused-blake-auth-only", name: `Worker ${company}`, role: "plumber", organisation: { id: `company-${company}`, name: `Company ${company}`, purchasePermission: "request" } });
  const backend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/action") { res.end(JSON.stringify({ status: "success", value: { tokens: { token: "synthetic-blake-auth" } } })); return; }
    assert.equal(req.headers["x-blake-sync-secret"], syncSecret);
    if (req.url === "/workforce/accounts/provision-from-blake") {
      provisioned.add(selected); res.end(JSON.stringify({ account: account(selected) })); return;
    }
    if (req.url === "/workforce/accounts/authenticate") {
      authenticationCalls.push(body);
      const company = body.accountId || body.companyId
        ? [...provisioned].find(c => body.accountId === `account-${c}` && body.companyId === `company-${c}`)
        : provisioned.size === 1 ? [...provisioned][0] : undefined;
      res.end(JSON.stringify({ account: company && body.email === email && !(company === "A" && revokedA) ? account(company) : null })); return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "Unknown test path" }));
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const upstream = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), WORKFORCE_HOST: "127.0.0.1", WORKFORCE_DEMO_MODE: "false", WORKFORCE_JWT_SECRET: secret, BLAKE_SYNC_SECRET: syncSecret, BLAKE_AUTH_URL: upstream, BLAKE_WORKFORCE_STORE_URL: upstream }, stdio: "ignore" });
  const closed = once(child, "close"), base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(`${base}/health`)).ok; } catch { /* starting local test server */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Gateway must start");
    async function signIn() {
      const response = await fetch(`${base}/v1/auth/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 200);
      return await response.json() as { accessToken: string; refreshToken: string };
    }
    const me = (token: string) => fetch(`${base}/v1/me?companyId=forged&accountId=forged`, { headers: { authorization: `Bearer ${token}` } });
    const refresh = (token: string) => fetch(`${base}/v1/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: token }) });
    const a = await signIn();
    assert.equal((await me(a.accessToken)).status, 200, "Single-company positive control");
    selected = "B";
    const b = await signIn();
    const first = await me(a.accessToken);
    assert.equal(first.status, 200, "A's valid existing scoped session must survive B provisioning");
    assert.equal((await first.json() as { organisation: { name: string } }).organisation.name, "Company A");
    const second = await me(b.accessToken); assert.equal(second.status, 200);
    assert.equal((await second.json() as { organisation: { name: string } }).organisation.name, "Company B");
    assert.deepEqual(authenticationCalls.at(-2), { email, accountId: "account-A", companyId: "company-A" });
    assert.deepEqual(authenticationCalls.at(-1), { email, accountId: "account-B", companyId: "company-B" });
    const renewed = await refresh(a.refreshToken); assert.equal(renewed.status, 200);
    const renewedToken = (await renewed.json() as { accessToken: string }).accessToken;
    assert.equal((await (await me(renewedToken)).json() as { organisation: { name: string } }).organisation.name, "Company A");
    const wrongPair = await new SignJWT({ tokenType: "access", email, organisationId: "company-B" }).setProtectedHeader({ alg: "HS256" }).setSubject("account-A").setExpirationTime("5m").sign(new TextEncoder().encode(secret));
    assert.equal((await me(wrongPair)).status, 401);
    for (const claims of [{ subject: "account-A", organisationId: undefined }, { subject: "account-A", organisationId: 2 }, { subject: undefined, organisationId: "company-A" }]) {
      let jwt = new SignJWT({ tokenType: "access", email, organisationId: claims.organisationId }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m");
      if (claims.subject) jwt = jwt.setSubject(claims.subject);
      assert.equal((await me(await jwt.sign(new TextEncoder().encode(secret)))).status, 401);
    }
    revokedA = true;
    assert.equal((await me(a.accessToken)).status, 401);
    assert.equal((await refresh(a.refreshToken)).status, 401);
    assert.equal((await me(b.accessToken)).status, 200, "Revoking A must not revoke B");
    revokedA = false;
    assert.equal((await me(a.accessToken)).status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    await closed;
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
  }
});
