import cors from "@fastify/cors";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { createHash } from "node:crypto";

type Role = "plumber" | "manager" | "office";
type PurchasePermission = "create" | "request";
type WorkforceUser = { id: string; email: string; passwordHash: string; name: string; role: Role; organisation: { id: string; name: string; purchasePermission: PurchasePermission } };
type WorkforceJob = { id: string; plumberId: string; date: string; reference: string; customer: string; site: string; scheduledTime: string; costCentres: string[] };

const signInInput = z.object({ email: z.string().email(), password: z.string().min(1) });
const activationInput = z.object({ code: z.string().uuid(), password: z.string().min(12).max(128) });
const dayInput = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const jobDateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const purchaseOrderInput = z.object({ jobDate: jobDateInput, key: z.string().min(1).max(200).optional(), taskId: z.string().optional(), costCentre: z.string().min(1), supplier: z.string().min(1), description: z.string().min(1).max(2000), quantity: z.number().positive().max(10000), cost: z.number().nonnegative().max(1000000), vatRate: z.number().optional() });
const timeInput = z.object({ jobDate: jobDateInput, taskId: z.string().optional(), start: z.string().min(1), finish: z.string().min(1), note: z.string().max(500).optional() });
const stopGoInput = z.object({ jobDate: jobDateInput, gate: z.string().min(1), answer: z.enum(["pass", "stop"]), note: z.string().max(500).optional() });
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
  if (!stored.account || stored.account.id !== verified.payload.sub || stored.account.organisation.id !== verified.payload.organisationId) throw new Error("UNAUTHENTICATED");
  return stored.account;
}

function account(user: WorkforceUser) { return { user: { name: user.name, role: user.role }, organisation: { name: user.organisation.name, purchasePermission: user.organisation.purchasePermission } }; }

async function blakeStore<T>(path: string, body: unknown): Promise<T> {
  if (!blakeSyncSecret) throw new Error("BLAKE_STORE_NOT_CONFIGURED");
  const response = await fetch(`${blakeWorkforceStoreUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-blake-sync-secret": blakeSyncSecret }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    throw new StoreError(response.status, response.status === 400 && error?.error ? error.error : "Blake is temporarily unavailable. Please try again.");
  }
  return await response.json() as T;
}

async function assignedJob(user: WorkforceUser, jobId: string, jobDate: string) {
  const jobs = await blakeStore<WorkforceJob[]>("/workforce/mobile/jobs", {
    ...actor(user),
    date: jobDate,
  });
  return { job: jobs.find(job => job.id === jobId) ?? null };
}

class StoreError extends Error { constructor(public status: number, message: string) { super(message); } }
function actor(user: WorkforceUser) { return { accountId: user.id, companyId: user.organisation.id }; }
function failure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const unauthorised = error instanceof Error && (error.message === "UNAUTHENTICATED" || ("code" in error && /^ERR_(JWT|JWS|JOSE)/.test(String(error.code))));
  if (unauthorised) return reply.code(401).send({ error: "Please sign in again." });
  request.log.error(error, "Workforce request failed");
  return reply.code(error instanceof StoreError && error.status === 400 ? 400 : 503).send({ error: error instanceof StoreError ? error.message : "Blake is temporarily unavailable. Please try again." });
}
const app = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });
await app.register(cors, { origin: process.env.WORKFORCE_ALLOWED_ORIGIN ?? false });

app.get("/", async () => ({ ok: true, service: "blake-workforce-api", mode: demoMode ? "demo" : "production" }));
app.get("/health", async () => ({ ok: true, service: "blake-workforce-api", revision: "durable-workflows-v1", mode: demoMode ? "demo" : "production" }));
app.post("/v1/integrations/blake/schedules", async (request, reply) => {
  if (!blakeSyncSecret || request.headers["x-blake-sync-secret"] !== blakeSyncSecret) return reply.code(401).send({ error: "Unauthorised schedule sync." });
  const parsed = blakeScheduleInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid schedule payload." });
  await blakeStore("/workforce/schedules", parsed.data);
  return { imported: parsed.data.jobs.length, skipped: 0 };
});
app.post("/v1/auth/activate", async (request, reply) => {
  const parsed = activationInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Enter your setup code and a password of at least 12 characters." });
  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const activated = await blakeStore<{ account: { email: string; name: string } }>("/workforce/invites/activate", { code: parsed.data.code, passwordHash });
    return reply.code(201).send({ ok: true, email: activated.account.email, name: activated.account.name });
  } catch (error) {
    request.log.error(error, "Workforce account activation failed");
    return reply.code(400).send({ error: "That setup code has expired or has already been used." });
  }
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
  try { return account(await currentUser(request)); } catch (error) { return failure(error, request, reply); }
});
app.get("/v1/jobs", async (request, reply) => {
  try {
    const parsed = dayInput.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "A valid date is required." });
    const user = await currentUser(request);
    return await blakeStore<WorkforceJob[]>("/workforce/mobile/jobs", { ...actor(user), date: parsed.data.date });
  } catch (error) {
    request.log.error(error, "Workforce jobs lookup failed");
    return failure(error, request, reply);
  }
});
app.get("/v1/jobs/:jobId", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const query = dayInput.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "A valid job date is required." });
    const result = await assignedJob(user, (request.params as { jobId: string }).jobId, query.data.date);
    return result.job ?? reply.code(404).send({ error: "Job not found." });
  } catch (error) { return failure(error, request, reply); }
});
app.post("/v1/jobs/:jobId/purchase-orders", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const parsed = purchaseOrderInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter the purchase order details." });
    const jobId = (request.params as { jobId: string }).jobId;
    // Legacy builds have no retry identifier. Identical legacy requests resolve
    // to the same durable receipt instead of creating duplicate financials.
    const key = parsed.data.key ?? createHash("sha256").update(JSON.stringify({ ...parsed.data, jobId })).digest("hex");
    return await blakeStore("/workforce/mobile/purchase", { ...parsed.data, key, ...actor(user), jobId });
  } catch (error) { return failure(error, request, reply); }
});
app.post("/v1/jobs/:jobId/time-confirmations", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const parsed = timeInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter valid time details." });
    const result = await blakeStore("/workforce/mobile/time", { ...parsed.data, ...actor(user), jobId: (request.params as { jobId: string }).jobId });
    return reply.code(201).send(result);
  } catch (error) { return failure(error, request, reply); }
});
// Old hard-coded forms cannot satisfy the office-assigned template. Do not
// accept them or show a false saved/office-notified confirmation.
app.post("/v1/jobs/:jobId/stop-go", async (request, reply) => {
  try { await currentUser(request); return reply.code(409).send({ error: "Update Blake Workforce to complete the forms assigned by your office." }); }
  catch (error) { return failure(error, request, reply); }
});
for (const route of ["files", "forms"]) app.get(`/v1/jobs/:jobId/${route}`, async (request, reply) => {
  try {
    const user = await currentUser(request);
    const query = dayInput.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "A valid job date is required." });
    return await blakeStore(`/workforce/mobile/${route}`, { ...actor(user), jobId: (request.params as { jobId: string }).jobId, jobDate: query.data.date });
  } catch (error) { return failure(error, request, reply); }
});
const formInput = z.object({
  jobDate: jobDateInput, key: z.string().min(1).max(200), templateId: z.string().min(1),
  customerType: z.enum(["domestic", "landlord"]),
  answers: z.array(z.object({ questionId: z.string().min(1), value: z.string().max(2000) })).max(200),
  warning: z.object({ classification: z.enum(["immediately_dangerous", "at_risk"]), faultDescription: z.string().min(1).max(2000), remedialAction: z.string().max(2000).optional(), isolationStatus: z.enum(["isolated", "permission_refused", "not_required"]), customerNotified: z.boolean(), customerAcknowledged: z.boolean() }).optional(),
});
app.post("/v1/jobs/:jobId/forms", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const parsed = formInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Complete the form details." });
    return reply.code(201).send(await blakeStore("/workforce/mobile/forms/submit", { ...parsed.data, ...actor(user), jobId: (request.params as { jobId: string }).jobId }));
  } catch (error) { return failure(error, request, reply); }
});
const fileInput = z.object({ jobDate: jobDateInput, fileName: z.string().min(1).max(180), mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]), base64: z.string().min(1).max(14 * 1024 * 1024) });
app.post("/v1/jobs/:jobId/files", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const parsed = fileInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Choose a photo or PDF no larger than 10 MB." });
    return reply.code(201).send(await blakeStore("/workforce/mobile/files/upload", { ...parsed.data, ...actor(user), jobId: (request.params as { jobId: string }).jobId }));
  } catch (error) { return failure(error, request, reply); }
});
for (const [route, backend] of [["suppliers", "suppliers"], ["purchase-requests", "requests"]]) app.get(`/v1/${route}`, async (request, reply) => {
  try { const user = await currentUser(request); return await blakeStore(`/workforce/mobile/${backend}`, actor(user)); }
  catch (error) { return failure(error, request, reply); }
});
app.post("/v1/purchase-requests/:requestId/review", async (request, reply) => {
  try {
    const user = await currentUser(request);
    const parsed = z.object({ decision: z.enum(["approved", "declined"]), reason: z.string().max(500).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Choose an approval decision." });
    return await blakeStore("/workforce/mobile/review", { ...parsed.data, ...actor(user), requestId: (request.params as { requestId: string }).requestId });
  } catch (error) { return failure(error, request, reply); }
});

if (!demoMode && !process.env.WORKFORCE_JWT_SECRET) throw new Error("WORKFORCE_JWT_SECRET must be set outside demo mode.");
await app.listen({ port: Number(process.env.PORT ?? 4100), host: process.env.WORKFORCE_HOST ?? "0.0.0.0" });
