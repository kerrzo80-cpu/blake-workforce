import type { FastifyInstance } from "fastify";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

type WebOptions = {
  enabled: string | undefined;
  officeOrigin: string | undefined;
  environment: string | undefined;
  gatewayCommit: string | undefined;
  backendUrl: string;
  releaseDirectory?: string;
};
const publicTypes: Record<string, string> = {
  "app-icon.png": "image/png",
  "app.js": "text/javascript; charset=utf-8",
  "blake-logo.png": "image/png",
  "blake-workforce-icon-v2.png": "image/png",
  "index.html": "text/html; charset=utf-8",
  "manifest.webmanifest": "application/manifest+json",
  "price-work-history.mjs": "text/javascript; charset=utf-8",
  "session.mjs": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "sw.js": "text/javascript; charset=utf-8",
  "unscheduled.js": "text/javascript; charset=utf-8",
  "uploads.js": "text/javascript; charset=utf-8",
  "work.js": "text/javascript; charset=utf-8",
};
const policy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function officeOrigin(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.port
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(
      "Workforce web requires a valid public HTTPS Office origin.",
    );
  }
}
/** Optional public web release. Only the fixed packaged files are readable;
 * auth endpoints, permission checks, signing keys and business data stay in the
 * existing API. No filesystem path, arbitrary proxy or cross-origin API is added. */
export async function registerWorkforceWeb(
  app: FastifyInstance,
  options: WebOptions,
): Promise<boolean> {
  if (options.enabled !== "true") return false;
  const office = officeOrigin(options.officeOrigin);
  if (
    options.environment !== "development" &&
    options.environment !== "production"
  )
    throw new Error("Workforce web requires an explicit environment.");
  const backend = new URL(options.backendUrl);
  if (
    !["https:", "http:"].includes(backend.protocol) ||
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash ||
    backend.pathname !== "/" ||
    (backend.protocol === "http:" &&
      !["127.0.0.1", "localhost"].includes(backend.hostname))
  )
    throw new Error("Workforce web backend binding is invalid.");
  const directory =
    options.releaseDirectory ??
    fileURLToPath(new URL("../web-release/", import.meta.url));
  const manifestFile = join(directory, "release.json");
  if (!(await lstat(manifestFile)).isFile())
    throw new Error("The packaged Workforce manifest must be a regular file.");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
    format?: unknown;
    sourceRepository?: unknown;
    sourceCommit?: unknown;
    files?: unknown;
  };
  if (
    manifest.format !== 1 ||
    manifest.sourceRepository !== "kerrzo80-cpu/blake-workforce-app" ||
    typeof manifest.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== Object.keys(publicTypes).length
  )
    throw new Error("The packaged Workforce web release is incomplete.");
  const assets = new Map<string, Buffer>();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      !Object.hasOwn(publicTypes, entry.name) ||
      assets.has(entry.name) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > 6_000_000
    )
      throw new Error("Invalid packaged Workforce web asset.");
    const assetFile = join(directory, entry.name);
    if (!(await lstat(assetFile)).isFile())
      throw new Error("The packaged Workforce asset must be a regular file.");
    const bytes = await readFile(assetFile);
    if (
      bytes.length !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw new Error("The packaged Workforce web asset changed.");
    assets.set(entry.name, bytes);
  }
  for (const name of Object.keys(publicTypes))
    if (!assets.has(name))
      throw new Error("The packaged Workforce web release is incomplete.");
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": policy,
  };
  for (const [name, bytes] of assets)
    app.get("/" + name, async (_request, reply) =>
      reply.headers(headers).type(publicTypes[name]).send(bytes),
    );
  app.get("/", async (_request, reply) =>
    reply
      .headers(headers)
      .type(publicTypes["index.html"])
      .send(assets.get("index.html")),
  );
  const config = `export const API = "";\nexport const BLAKE_ORIGIN = ${JSON.stringify(office)};\nexport const ENVIRONMENT = ${JSON.stringify(options.environment)};\n`;
  app.get("/config.js", async (_request, reply) =>
    reply.headers(headers).type("text/javascript; charset=utf-8").send(config),
  );
  app.get("/workforce-web-release.json", async (_request, reply) =>
    reply
      .headers(headers)
      .send({
        ...manifest,
        gatewayCommit: /^[a-f0-9]{40}$/.test(options.gatewayCommit ?? "")
          ? options.gatewayCommit
          : null,
        environment: options.environment,
        officeOrigin: office,
        api: "same-origin",
        backendHost: backend.host,
      }),
  );
  return true;
}
