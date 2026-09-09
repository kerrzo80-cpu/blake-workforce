import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";

test("HTTP gateway authenticates, scopes writes and reports upstream failures honestly", async () => {
  const password = randomBytes(24).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const syncSecret = randomBytes(32).toString("hex");
  const passwordHash = await bcrypt.hash(password, 4);
  let unavailable = false;
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const backend = createServer(async (req, res) => {
    if(req.url !== "/api/action") assert.equal(req.headers["x-blake-sync-secret"], syncSecret);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (unavailable) { res.statusCode = 503; res.end(JSON.stringify({ error: "private upstream detail" })); return; }
    if(req.url === "/api/action") {res.end(JSON.stringify({status:"success",value:{tokens:{token:"test-only"}}}));return;}
    if (req.url === "/workforce/accounts/authenticate" || req.url === "/workforce/accounts/provision-from-blake") res.end(JSON.stringify({ account: body.email === "test@example.test" ? { id: "account-1", email: "test@example.test", passwordHash, name: "Test", role: "plumber", organisation: { id: "company-1", name: "Test", purchasePermission: "request" } } : null }));
    else if (req.url === "/workforce/mobile/jobs") res.end(JSON.stringify([{ id: "job-1", date: body.date, reference: "JB-TEST", costCentres: ["Bathroom"], tasks: [{ id: "task-1", name: "Bathroom" }] }]));
    else if (req.url === "/workforce/mobile/purchase") res.end(JSON.stringify({ reference: "POR-TEST", status: "requested" }));
    else if (req.url?.startsWith("/workforce/mobile/work/") || req.url?.startsWith("/workforce/mobile/completions/")) res.end(JSON.stringify({id:"saved-record",active:false,status:"signed"}));
    else if (req.url === "/workforce/mobile/time") res.end(JSON.stringify({ ok: true, status: "pending-office-review" }));
    else { res.statusCode = 400; res.end(JSON.stringify({ error: "Rejected test operation" })); }
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const backendPort = (backend.address() as { port: number }).port;
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), WORKFORCE_HOST: "127.0.0.1", WORKFORCE_DEMO_MODE: "false", WORKFORCE_JWT_SECRET: secret, BLAKE_SYNC_SECRET: syncSecret, BLAKE_WORKFORCE_STORE_URL: `http://127.0.0.1:${backendPort}` }, stdio: ["ignore", "ignore", "pipe"] });
  let startupError = ""; child.stderr?.on("data", data => { startupError += String(data); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(`${base}/health`)).ok; } catch { /* process starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `Gateway must start: ${startupError}`);
    assert.equal((await fetch(`${base}/v1/jobs?date=2026-09-08`)).status, 401);
    const signIn = await fetch(`${base}/v1/auth/sign-in`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "test@example.test", password }) });
    assert.equal(signIn.status, 200);
    const session = await signIn.json() as { accessToken: string };
    const headers = { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` };
    const jobs = await fetch(`${base}/v1/jobs?date=2026-09-08`, { headers });
    assert.equal(jobs.status, 200);
    const purchase = { jobDate: "2026-09-08", key: "retry-1", costCentre: "Bathroom", supplier: "Test supplier", description: "Test item", quantity: 1, cost: 10, companyId: "attack-company", accountId: "attack-account" };
    const post = await fetch(`${base}/v1/jobs/job-1/purchase-orders`, { method: "POST", headers, body: JSON.stringify(purchase) });
    assert.equal(post.status, 200); assert.deepEqual(await post.json(), { reference: "POR-TEST", status: "requested" });
    const forwarded = calls.filter(call => call.path === "/workforce/mobile/purchase").at(-1)!.body;
    assert.equal(forwarded.companyId, "company-1"); assert.equal(forwarded.accountId, "account-1"); assert.equal(forwarded.jobId, "job-1");
    const simplePO=await fetch(`${base}/v1/jobs/job-1/purchase-orders`,{method:"POST",headers,body:JSON.stringify({jobDate:"2026-09-08",key:"supplier-only",costCentre:"Bathroom",supplier:"Test supplier",referenceOnly:true})});
    assert.equal(simplePO.status,200);
    assert.equal(calls.filter(c=>c.path==="/workforce/mobile/purchase").at(-1)!.body.referenceOnly,true);
    for (const [route, input] of [
      ["work/start", {jobDate:"2026-09-09",taskId:"task-1",key:"start"}],
      ["work/stop", {sessionId:"visit-1",expectedVersion:1,key:"stop"}],
      ["work/amend", {jobDate:"2026-09-09",taskId:"task-1",sessionId:"visit-1",expectedVersion:2,key:"amend",start:"08:00",finish:"10:00",reason:"Forgot to stop"}],
      ["completions/complete", {jobDate:"2026-09-09",taskIds:["task-1"],wholeJob:false,key:"complete",workSummary:"Done",unavailableReason:"Customer away"}],
    ] as const) {
      const write = await fetch(`${base}/v1/jobs/job-1/${route}`, {method:"POST",headers,body:JSON.stringify({...input,companyId:"forged",accountId:"forged",jobId:"forged"})});
      assert.equal(write.status,200);
      const sent=calls.filter(c=>c.path===`/workforce/mobile/${route}`).at(-1)!.body;
      assert.equal(sent.companyId,"company-1");assert.equal(sent.accountId,"account-1");
      assert.equal(sent.jobId,route==="work/stop"?undefined:"job-1");
      assert.equal((await fetch(`${base}/v1/jobs/job-1/${route}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)})).status,401);
    }
    const badAmend=await fetch(`${base}/v1/jobs/job-1/work/amend`,{method:"POST",headers,body:JSON.stringify({jobDate:"2026-09-09",taskId:"task-1",start:"08:00",finish:"09:00",reason:"",key:"empty"})});assert.equal(badAmend.status,400);
    const oldForm = await fetch(`${base}/v1/jobs/job-1/stop-go`, { method: "POST", headers, body: JSON.stringify({ jobDate: "2026-09-08", gate: "Fake gate", answer: "pass" }) });
    assert.equal(oldForm.status, 409);
    const forged = await new SignJWT({ email: "test@example.test", organisationId: "company-1" }).setProtectedHeader({ alg: "HS256" }).setSubject("different-account").setExpirationTime("5m").sign(new TextEncoder().encode(secret));
    assert.equal((await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${forged}` } })).status, 401);
    unavailable = true;
    const failed = await fetch(`${base}/v1/jobs?date=2026-09-08`, { headers });
    assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes("private upstream detail"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    backend.closeAllConnections();
    await new Promise<void>(resolve => backend.close(() => resolve()));
  }
});
