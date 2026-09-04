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
const secret = new TextEncoder().encode(process.env.WORKFORCE_JWT_SECRET ?? "development-only-secret-change-before-deploy");
const demoMode = process.env.WORKFORCE_DEMO_MODE === "true";

const users: WorkforceUser[] = demoMode ? [{
  id: "workforce-user-demo", email: "plumber@example.test", passwordHash: bcrypt.hashSync("change-me", 12), name: "Demo Plumber", role: "plumber",
  organisation: { id: "ewg", name: "Errol Watson Group", purchasePermission: "create" },
}] : [];
const jobs: WorkforceJob[] = demoMode ? [{ id: "job-demo-1", plumberId: "workforce-user-demo", date: "2026-09-04", reference: "JB-DEMO-001", customer: "Demo customer", site: "12 Example Street", scheduledTime: "08:00", costCentres: ["Bathroom · Plumbing"] }] : [];
const submissions: Array<{ type: string; jobId: string; createdAt: string; data: unknown }> = [];

async function makeToken(user: WorkforceUser) {
  return new SignJWT({ role: user.role, organisationId: user.organisation.id }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setExpirationTime("8h").sign(secret);
}

async function currentUser(request: FastifyRequest) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("UNAUTHENTICATED");
  const verified = await jwtVerify(token, secret);
  const user = users.find(item => item.id === verified.payload.sub);
  if (!user) throw new Error("UNAUTHENTICATED");
  return user;
}

function account(user: WorkforceUser) { return { user: { name: user.name, role: user.role }, organisation: { name: user.organisation.name, purchasePermission: user.organisation.purchasePermission } }; }

const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.WORKFORCE_ALLOWED_ORIGIN ?? false });

app.get("/", async () => ({ ok: true, service: "blake-workforce-api", mode: demoMode ? "demo" : "production" }));
app.get("/health", async () => ({ ok: true, service: "blake-workforce-api", mode: demoMode ? "demo" : "production" }));
app.post("/v1/auth/sign-in", async (request, reply) => {
  const parsed = signInInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid email or password." });
  const user = users.find(item => item.email.toLowerCase() === parsed.data.email.toLowerCase());
  if (!user || !await bcrypt.compare(parsed.data.password, user.passwordHash)) return reply.code(401).send({ error: "Invalid email or password." });
  return { ...account(user), accessToken: await makeToken(user) };
});
app.get("/v1/me", async (request, reply) => {
  try { return account(await currentUser(request)); } catch { return reply.code(401).send({ error: "Unauthenticated" }); }
});
app.get("/v1/jobs", async (request, reply) => {
  try {
    const parsed = dayInput.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "A valid date is required." });
    const user = await currentUser(request);
    return jobs.filter(job => job.plumberId === user.id && job.date === parsed.data.date);
  } catch { return reply.code(401).send({ error: "Unauthenticated" }); }
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
    submissions.push({ type: "time-confirmation", jobId: job.id, createdAt: new Date().toISOString(), data: parsed.data });
    return reply.code(201).send({ ok: true });
  } catch { return reply.code(401).send({ error: "Unauthenticated" }); }
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
