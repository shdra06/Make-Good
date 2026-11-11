// The app for demo-video.ts, in its own process so that recording frames is
// not slowed by the server's work. In-memory database, PayPal simulator.
//   node scripts/demo-video-server.ts <port> [--ai]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/api/routes.ts";
import { createContainer } from "../src/container.ts";
import { loadConfig } from "../src/platform/config.ts";
import { openDb } from "../src/platform/db/db.ts";
import { migrate } from "../src/platform/db/migrate.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const PORT = Number(process.argv[2] ?? 4200);
const useAi = process.argv.includes("--ai");

const fromFile = loadConfig();
const config = loadConfig({ ...process.env, NODE_ENV: "development", LOG_LEVEL: "silent", PORT: String(PORT), PUBLIC_URL: `http://localhost:${PORT}` }, { readEnvFiles: false });
const db = await openDb({ pglite: "memory" });
await migrate(db);
const c = await createContainer({ ...config, gemini: useAi ? fromFile.gemini : null }, { db, passwordCost: { N: 1024, r: 8, p: 1 } });
const { app } = buildApp(c);
const { default: fastifyStatic } = await import("@fastify/static");
await app.register(fastifyStatic, { root: path.join(REPO, "apps", "web", "public"), wildcard: false });
await app.listen({ port: PORT, host: "127.0.0.1" });
c.runner.start();
console.log(`READY ${c.ai ? c.ai.model : "off"}`);
