// The API process. In development it also runs the job worker, so one command
// starts everything. In production run `node src/worker.ts` separately and set
// WORKER_INLINE=0 here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./api/routes.ts";
import { createContainer } from "./container.ts";
import { loadConfig } from "./platform/config.ts";
import { enqueue } from "./platform/jobs/queue.ts";

const config = loadConfig();
const container = await createContainer(config);
const { app } = buildApp(container);

// Serve the old one-page app (legacy-web) from the API until the Next.js app in apps/web replaces it.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../legacy-web/public");
if (fs.existsSync(path.join(webDist, "index.html"))) {
  const { default: fastifyStatic } = await import("@fastify/static");
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found." } });
  });
}

let sweepTimer: NodeJS.Timeout | null = null;
if (config.workerInline) {
  container.runner.start();
  const sweep = () => void enqueue(container.db, { type: "operations.sweep", dedupeKey: "operations.sweep" }, container.clock.now()).catch(() => undefined);
  sweep();
  sweepTimer = setInterval(sweep, 60_000);
}

await app.listen({ port: config.port, host: "0.0.0.0" });
if (config.encryptionKeySource === "generated-for-development") {
  app.log.warn("Using a development encryption key from the data folder. Set MAKEGOOD_ENCRYPTION_KEY for anything real.");
}

async function shutdown(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer);
  await app.close();
  await container.runner.stop();
  await container.db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
