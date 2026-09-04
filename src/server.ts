import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";

type Role = "plumber" | "manager" | "office";
type PurchasePermission = "create" | "request";
type WorkforceUser = { id: string; email: string; passwordHash: string; name: string; role: Role; organisation: { id: string; name: string; purchasePermission: PurchasePermission } };
type WorkforceJob = { id: string; plumberId: string; date: string; reference: string; customer: string; site: string; scheduledTime: string; costCentres: string[] };

const signInInput = z.object({ email: z.string().email(), password: z.string().min(1) });
const dayInput = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const purchaseOrderInput = z.object({ costCentre: z.string().min(1), supplier: z.string().min(1), description: z.string().min(1), quantity: z.number().positive(), cost: z.number().nonnegative() });
const timeInput = z.object({ start: z.string().min(1), finish: z.string().min(1), note: z.string().max(500).optional() });
const stopGoInput = z.object({ gate: z.string().min(1), answer: z.enum(["pass", "stop"]), note: z.string().max(500).optional() });
const blakeScheduleInput = z.object({ jobs: z.array(z.object({ plumberEmail: z.string().email(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reference: z.string().min(1), customer: z.string().min(1), site: z.string().min(1), scheduledTime: z.string().min(1), costCentres: z.array(z.string().min(1)).min(1) })) });
const secret = new TextEncoder().encode(process.env.WORKFORCE_JWT_SECRET ?? "development-only-secret-change-before-deploy");
const demoMode = process.env.WORKFORCE_DEMO_MODE === "true";
const blakeSyncSecret = process.env.BLAKE_SYNC_SECRET;
const blakeTimeConfirmationUrl = process.env.BLAKE_TIME_CONFIRMATION_URL ?? "https://insightful-lark-403.eu-west-1.convex.site/workforce/time-confirmations";
const blakeWorkforceStoreUrl = process.env.BLAKE_WORKFORCE_STORE_URL ?? "https://insightful-lark-403.eu-west-1.convex.site";

const users: WorkforceUser[] = demoMode ? [{
  id: "workforce-user-demo", email: "plumber@example.test", passwordHash: bcrypt.hashSync("change-me", 12), name: "Demo Plumber", role: "plumber",
  organisation: { id: "ewg", name: "Errol Watson Group", purchasePermission: "create" },
}] : [];
const jobs: WorkforceJob[] = demoMode ? [{ id: "job-demo-1", plumberId: "workforce-user-demo", date: "2026-09-04", reference: "JB-DEMO-001", customer: "Demo customer", site: "12 Example Street", scheduledTime: "08:00", costCentres: ["Bathroom · Plumbing"] }] : [];
const submissions: Array<{ type: string; jobId: string; createdAt: string; data: unknown }> = [];

async function makeToken(user: WorkforceUser) {
  return new SignJWT({ role: user.role, organisationId: user.organisation.id, email: user.email }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setExpirationTime("8h").sign(secret);
}

async function currentUser(request: FastifyRequest) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("UNAUTHENTICATED");
  const verified = await jwtVerify(token, secret);
  const email = typeof verified.payload.email === "string" ? verified.payload.email : undefined;
  if (!email) throw new Error("UNAUTHENTICATED");
  const stored = await blakeStore<{ account: WorkforceUser | null }>("/workforce/accounts/authenticate", { email });
  if (!stored.account) throw new Error("UNAUTHENTICATED");
  return stored.account;
}

function account(user: WorkforceUser) { return { user: { name: user.name, role: user.role }, organisation: { name: user.organisation.name, purchasePermission: user.organisation.purchasePermission } }; }

async function blakeStore<T>(path: string, body: unknown): Promise<T> {
  if (!blakeSyncSecret) throw new Error("BLAKE_STORE_NOT_CONFIGURED");
  const response = await fetch(`${blakeWorkforceStoreUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-blake-sync-secret": blakeSyncSecret }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`BLAKE_STORE_${response.status}`);
  return await response.json() as T;
}

function minutesFromClock(value: string) {
  const match = /^([01]\\d|2[0-3]):([0-5]\\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function scheduledMinutes(value: string) {
  const [start, finish] = value.split("-");
  const startMinutes = minutesFromClock(start ?? "");
  const finishMinutes = minutesFromClock(finish ?? "");
  return startMinutes !== null && finishMinutes !== null && finishMinutes > startMinutes ? finishMinutes - startMinutes : 0;
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.WORKFORCE_ALLOWED_ORIGIN ?? false });

app.get("/", async () => ({ ok: true, service: "blake-workforce-api", mode: demoMode ? "demo" : "production" }));
app.get("/health", async () => ({ ok: true, service: "blake-workforce-api", mode: demoMode ? "demo" : "production" }));
app.post("/v1/integrations/blake/schedules", async (request, reply) => {
  if (!blakeSyncSecret || request.headers["x-blake-sync-secret"] !== blakeSyncSecret) return reply.code(401).send({ error: "Unauthorised schedule sync." });
  const parsed = blakeScheduleInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid schedule payload." });
  await blakeStore("/workforce/schedules", parsed.data);
  let imported = 0;
  for (const incoming of parsed.data.jobs) {
    const plumber = users.find(user => user.email.toLowerCase() === incoming.plumberEmail.toLowerCase());
    if (!plumber) continue;
    const existingIndex = jobs.findIndex(job => job.plumberId === plumber.id && job.reference === incoming.reference && job.date === incoming.date);
    const synced: WorkforceJob = { id: existingIndex >= 0 ? jobs[existingIndex].id : `blake-${incoming.reference}-${incoming.date}`, plumberId: plumber.id, date: incoming.date, reference: incoming.reference, customer: incoming.customer, site: incoming.site, scheduledTime: incoming.scheduledTime, costCentres: incoming.costCentres };
    if (existingIndex >= 0) jobs[existingIndex] = synced; else jobs.push(synced);
    imported += 1;
  }
  return { imported, skipped: parsed.data.jobs.length - imported };
});
app.post("/v1/auth/sign-in", async (request, reply) => {
  const parsed = signInInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid email or password." });
  try {
    const stored = await blakeStore<{ account: WorkforceUser | null }>("/workforce/accounts/authenticate", { email: parsed.data.email });
    const user = stored.account;
    if (!user || !await bcrypt.compare(parsed.data.password, user.passwordHash)) return reply.code(401).send({ error: "Invalid email or password." });
    return { ...account(user), accessToken: await makeToken(user) };
  } catch (error) {
    request.log.error(error, "Workforce account lookup failed");
    return reply.code(503).send({ error: "Workforce accounts are temporarily unavailable." });
  }
});
app.get("/v1/me", async (request, reply) => {
  try { return account(await currentUser(request)); } catch { return reply.code(401).send({ error: "Unauthenticated" }); }
});
app.get("/v1/jobs", async (request, reply) => {
  try {
    const parsed = dayInput.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "A valid date is required." });
    const user = await currentUser(request);
    const stored = await blakeStore<{ jobs: WorkforceJob[] }>("/workforce/jobs", { email: user.email, date: parsed.data.date });
    return stored.jobs;
  } catch (error) {
    request.log.error(error, "Workforce jobs lookup failed");
    return reply.code(401).send({ error: "Unauthenticated" });
  }
});
app.get("/v1/jobs/:jobId", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const job = jobs.find(item => item.id === (request.params as { jobId: string }).jobId && item.plumberId === user.id);
    return job ?? reply.code(404).send({ error: "Job not found." });
  } catch { return reply.code(401).send({ error: "Unauthenticated" }); }
});
app.post("/v1/jobs/:jobId/purchase-orders", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const job = jobs.find(item => item.id === (request.params as { jobId: string }).jobId && item.plumberId === user.id);
    if (!job) return reply.code(404).send({ error: "Job not found." });
    const parsed = purchaseOrderInput.safeParse(request.body);
    if (!parsed.success || !job.costCentres.includes(parsed.data.costCentre)) return reply.code(400).send({ error: "Choose one of your scheduled cost centres." });
    const status = user.organisation.purchasePermission === "create" ? "created" : "requested";
    const reference = `${status === "created" ? "PO" : "POR"}-${String(submissions.length + 1).padStart(5, "0")}`;
    submissions.push({ type: "purchase-order", jobId: job.id, createdAt: new Date().toISOString(), data: { ...parsed.data, status, reference } });
    return { reference, status };
  } catch { return reply.code(401).send({ error: "Unauthenticated" }); }
});
app.post("/v1/jobs/:jobId/time-confirmations", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const job = jobs.find(item => item.id === (request.params as { jobId: string }).jobId && item.plumberId === user.id);
    const parsed = timeInput.safeParse(request.body);
    if (!job || !parsed.success) return reply.code(400).send({ error: "Invalid time confirmation." });
    const startMinutes = minutesFromClock(parsed.data.start);
    const finishMinutes = minutesFromClock(parsed.data.finish);
    if (startMinutes === null || finishMinutes === null || finishMinutes <= startMinutes) {
      return reply.code(400).send({ error: "Enter a valid start and finish time." });
    }
    if (!blakeSyncSecret) return reply.code(503).send({ error: "Time return is not configured." });

    const submittedAt = new Date().toISOString();
    const payload = {
      workforceEntryId: `time-${job.id}-${user.id}-${submittedAt}`,
      plumberEmail: user.email,
      jobReference: job.reference,
      costCentre: job.costCentres[0] ?? "Unassigned",
      workDate: job.date,
      scheduledMinutes: scheduledMinutes(job.scheduledTime),
      actualMinutes: finishMinutes - startMinutes,
      amendmentReason: parsed.data.note,
    };
    const response = await fetch(blakeTimeConfirmationUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-blake-sync-secret": blakeSyncSecret },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      request.log.error({ statusCode: response.status }, "Blake timesheet return failed");
      return reply.code(502).send({ error: "Could not send your time to Blake. Please try again." });
    }
    submissions.push({ type: "time-confirmation", jobId: job.id, createdAt: submittedAt, data: { ...parsed.data, returnedToBlake: true } });
    return reply.code(201).send({ ok: true, status: "pending-office-review" });
  } catch (error) {
    request.log.error(error, "Time confirmation failed");
    return reply.code(401).send({ error: "Unauthenticated" });
  }
});
app.post("/v1/jobs/:jobId/stop-go", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const job = jobs.find(item => item.id === (request.params as { jobId: string }).jobId && item.plumberId === user.id);
    const parsed = stopGoInput.safeParse(request.body);
    if (!job || !parsed.success) return reply.code(400).send({ error: "Invalid stop/go record." });
    submissions.push({ type: "stop-go", jobId: job.id, createdAt: new Date().toISOString(), data: parsed.data });
    return reply.code(201).send({ ok: true, action: parsed.data.answer === "stop" ? "work-stopped" : "recorded" });
  } catch { return reply.code(401).send({ error: "Unauthenticated" }); }
});

if (!demoMode && !process.env.WORKFORCE_JWT_SECRET) throw new Error("WORKFORCE_JWT_SECRET must be set outside demo mode.");
await app.listen({ port: Number(process.env.PORT ?? 4100), host: "0.0.0.0" });
