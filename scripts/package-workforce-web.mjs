import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const [checkout, sourceCommit] = process.argv.slice(2);
if (!checkout || !/^[a-f0-9]{40}$/.test(sourceCommit ?? ""))
  throw new Error(
    "An explicit maintained Workforce checkout and40-character commit are required.",
  );
const output = fileURLToPath(new URL("../web-release/", import.meta.url));
const names = [
  "app-icon.png",
  "app.js",
  "blake-logo.png",
  "blake-workforce-icon-v2.png",
  "index.html",
  "manifest.webmanifest",
  "price-work-history.mjs",
  "session.mjs",
  "styles.css",
  "sw.js",
  "unscheduled.js",
  "uploads.js",
  "work.js",
];
const git = (args) =>
  execFileSync("git", ["-C", checkout, ...args], { maxBuffer: 12_000_000 });
const resolved = git(["rev-parse", sourceCommit + "^{commit}"])
  .toString()
  .trim();
if (resolved !== sourceCommit)
  throw new Error("The requested Workforce release could not be resolved.");
await mkdir(output, { recursive: true });
const files = [];
for (const name of names) {
  const entry = git(["ls-tree", sourceCommit, "--", "web/" + name]).toString();
  if (!/^100644 blob [a-f0-9]{40}\t/.test(entry))
    throw new Error("Only tracked regular public web files may be packaged.");
  const bytes = git(["show", sourceCommit + ":web/" + name]);
  if (!bytes.length || bytes.length > 6_000_000)
    throw new Error("Invalid public Workforce asset.");
  await writeFile(output + name, bytes);
  files.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(
  output + "release.json",
  JSON.stringify(
    {
      format: 1,
      sourceRepository: "kerrzo80-cpu/blake-workforce-app",
      sourceCommit,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    sourceCommit,
    publicFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    configuration:
      "Runtime same-origin API; production config, tests, env/auth/customer files are excluded.",
  }),
);
