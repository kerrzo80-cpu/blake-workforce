import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
for (const [name, value] of [
  ["missing", undefined],
  ["known public fallback", "development-only-secret-change-before-deploy"],
] as const) {
  test(`refuses to listen with a ${name} JWT signing key`, async () => {
    const reserve = createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      WORKFORCE_HOST: "127.0.0.1",
      WORKFORCE_DEMO_MODE: "false",
      WORKFORCE_WEB_ENABLED: "false",
      BLAKE_SYNC_SECRET: "synthetic-isolated-upstream-key",
      BLAKE_WORKFORCE_STORE_URL: "http://127.0.0.1:9",
      BLAKE_AUTH_URL: "http://127.0.0.1:9",
      BLAKE_TIME_CONFIRMATION_URL: "http://127.0.0.1:9",
    };
    delete env.WORKFORCE_JWT_SECRET;
    if (value !== undefined) env.WORKFORCE_JWT_SECRET = value;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/server.ts"],
      { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let exited = false;
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    const closed = once(child, "close").then(() => {
      exited = true;
    });
    try {
      let listening = false;
      for (let i = 0; i < 50 && !exited; i++) {
        try {
          listening = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch {
          /* Startup or closed. */
        }
        if (listening) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        listening,
        false,
        "The gateway must not listen with an absent or publicly known signing key.",
      );
      assert.equal(
        exited,
        true,
        "Invalid signing configuration must fail startup.",
      );
      assert.match(stderr, /WORKFORCE_JWT_SECRET must be configured/);
    } finally {
      if (!exited) child.kill("SIGTERM");
      await closed;
    }
  });
}
