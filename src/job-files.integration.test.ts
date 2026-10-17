import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

test("private job files are streamed through current scoped gateway access", async t => {
  const secret = randomBytes(32).toString("hex"), syncSecret = randomBytes(32).toString("hex");
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const original = Buffer.from("AUDIT ONLY\nSynthetic private job document.\n");
  let disabled = false, mode = "ok", redirected = 0;
  const backend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    calls.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/action") { res.end(JSON.stringify({ status: "success", value: { tokens: { token: "test-only" } } })); return; }
    assert.equal(req.headers["x-blake-sync-secret"], syncSecret);
    if (req.url === "/workforce/accounts/authenticate" || req.url === "/workforce/accounts/provision-from-blake") {
      res.end(JSON.stringify({ account: disabled ? null : { id: "account-1", email: "test@example.test", name: "Synthetic", role: "plumber", organisation: { id: "company-1", name: "Synthetic", purchasePermission: "request" } } })); return;
    }
    if (req.url === "/redirect-target") { redirected++; res.end("must never follow"); return; }
    if (req.url === "/workforce/mobile/files/download") {
      if (mode === "denied" || body.documentId !== "doc-1") { res.statusCode = 403; res.end(JSON.stringify({ error: "private upstream provenance details" })); return; }
      if (mode === "unavailable") { res.statusCode = 503; res.end(JSON.stringify({ error: "private upstream failure" })); return; }
      if (mode === "redirect") { res.writeHead(302, { location: "/redirect-target" }); res.end(); return; }
      if (mode === "oversize-header") { res.setHeader("content-length", 21 * 1024 * 1024); res.end(); return; }
      if (mode === "empty") { res.statusCode = 204; res.end(); return; }
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", "attachment; filename*=UTF-8''audit-only.pdf");
      res.setHeader("set-cookie", "must-not-forward=test");
      if (mode === "oversize-stream") { res.end(Buffer.alloc(20 * 1024 * 1024 + 1)); return; }
      res.end(original); return;
    }
    res.statusCode = 400; res.end("{}");
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const backendPort = (backend.address() as { port: number }).port;
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.env.BLAKE_FILE_TEST_SOURCE || process.cwd(),
    env: { ...process.env, PORT: String(port), WORKFORCE_HOST: "127.0.0.1", WORKFORCE_DEMO_MODE: "false", WORKFORCE_JWT_SECRET: secret, BLAKE_SYNC_SECRET: syncSecret, BLAKE_AUTH_URL: `http://127.0.0.1:${backendPort}`, BLAKE_TIME_CONFIRMATION_URL: `http://127.0.0.1:${backendPort}/workforce/time-confirmations`, BLAKE_WORKFORCE_STORE_URL: `http://127.0.0.1:${backendPort}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; child.stdout.on("data", value => { logs += String(value); }); child.stderr.on("data", value => { logs += String(value); });
  const closed = once(child, "close"), base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(base + "/health")).ok; } catch { /* child starting */ } if (ready) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.ok(ready, "Isolated gateway must start");
    const signIn = await fetch(base + "/v1/auth/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "test@example.test", password: "synthetic-only" }) });
    assert.equal(signIn.status, 200);
    const session = await signIn.json() as { accessToken: string };
    const headers = { authorization: `Bearer ${session.accessToken}` };
    const url = base + "/v1/jobs/job-1/files/doc-1?date=2026-10-16";
    const fileCalls = () => calls.filter(call => call.path === "/workforce/mobile/files/download");
    await t.test("control: established authenticated session remains valid", async () => {
      assert.equal((await fetch(base + "/v1/me", { headers })).status, 200);
    });
    await t.test("control: established account endpoint rejects anonymous access", async () => {
      assert.equal((await fetch(base + "/v1/me")).status, 401);
    });
    await t.test("anonymous and malformed visit requests never reach file storage", async () => {
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(base + "/v1/jobs/job-1/files/doc-1?date=bad", { headers })).status, 400);
      assert.equal(fileCalls().length, 0);
    });
    await t.test("session owns actor and company; bytes and safe attachment headers survive", async () => {
      const r = await fetch(url + "&companyId=foreign&accountId=foreign&documentId=other&jobId=other", { headers });
      assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), original);
      assert.deepEqual(fileCalls().at(-1)!.body, { companyId: "company-1", accountId: "account-1", jobId: "job-1", jobDate: "2026-10-16", documentId: "doc-1" });
      assert.equal(r.headers.get("content-type"), "application/pdf"); assert.equal(r.headers.get("cache-control"), "no-store"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("content-disposition"), "attachment; filename*=UTF-8''audit-only.pdf"); assert.equal(r.headers.get("set-cookie"), null);
    });
    await t.test("revoked current accounts are denied before another file request", async () => {
      disabled = true; const count = fileCalls().length; const r = await fetch(url, { headers }); disabled = false;
      assert.equal(r.status, 401); assert.equal(fileCalls().length, count); assert.equal(r.headers.get("cache-control"), "no-store");
    });
    await t.test("current assignment, file and provenance denials stay private", async () => {
      mode = "denied"; const r = await fetch(url, { headers }); mode = "ok";
      assert.equal(r.status, 403); assert.equal(r.headers.get("cache-control"), "no-store"); assert.ok(!(await r.text()).includes("private upstream"));
    });
    await t.test("upstream failures and redirects never leak details or follow secrets", async () => {
      for (const value of ["unavailable", "redirect"]) { mode = value; const r = await fetch(url, { headers }); assert.equal(r.status, 503); assert.ok(!(await r.text()).includes("private upstream")); }
      mode = "ok"; assert.equal(redirected, 0);
    });
    await t.test("empty and oversized streams fail closed without returning file bytes", async () => {
      for (const value of ["oversize-header", "oversize-stream", "empty"]) { mode = value; const r = await fetch(url, { headers }); assert.equal(r.status, 503); assert.match(await r.text(), /Could not download/); }
      mode = "ok";
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed; backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
  }
  assert.ok(!logs.includes(syncSecret));
});
