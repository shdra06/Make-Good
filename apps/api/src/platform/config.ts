// Configuration comes from the environment and is checked once at start.
// Nothing else reads process.env.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { generateEncryptionKey } from "./crypto.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const bool = z
  .enum(["0", "1", "true", "false"])
  .transform((v) => v === "1" || v === "true");

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  /** PostgreSQL connection string. Without it the built-in local database is used. */
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default(path.join(ROOT, ".data")),
  /** 32 random bytes, base64. Encrypts PayPal and store secrets at rest. Required in production. */
  MAKEGOOD_ENCRYPTION_KEY: z.string().optional(),
  /** Run the job worker inside the API process. Simple for one machine; split them when you scale. */
  WORKER_INLINE: bool.optional(),
  /** The built-in PayPal simulator. Off in production unless switched on deliberately. */
  ALLOW_SIMULATOR: bool.optional(),
  /**
   * Live PayPal is refused unless this is set to the exact phrase below.
   * Sandbox is the default everywhere.
   */
  ALLOW_LIVE_PAYPAL: z.string().optional(),
  /** Platform credentials for PayPal seller onboarding (partner mode). Needs PayPal approval. */
  PAYPAL_PARTNER_CLIENT_ID: z.string().optional(),
  PAYPAL_PARTNER_CLIENT_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  MAKEGOOD_MODEL: z.string().default("claude-opus-5-5"),
  /** Google Gemini, used for evidence work when no Anthropic key is set. */
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  /** "file" writes emails to DATA_DIR/outbox for local work. "resend" sends them. */
  EMAIL_TRANSPORT: z.enum(["file", "resend"]).default("file"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Make Good <notices@example.com>"),
  /** Public reference exchange rates (European Central Bank, via Frankfurter). Indicative only. */
  FX_API_URL: z.string().url().default("https://api.frankfurter.dev/v1"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export const LIVE_PAYPAL_PHRASE = "I understand this moves real money";

export type Config = {
  env: "development" | "test" | "production";
  port: number;
  publicUrl: string;
  databaseUrl: string | null;
  dataDir: string;
  encryptionKey: string;
  encryptionKeySource: "environment" | "generated-for-development";
  workerInline: boolean;
  allowSimulator: boolean;
  allowLivePayPal: boolean;
  paypalPartner: { clientId: string; clientSecret: string } | null;
  anthropicApiKey: string | null;
  model: string;
  gemini: { apiKey: string; model: string } | null;
  email: { transport: "file" | "resend"; resendApiKey: string | null; from: string };
  fxApiUrl: string;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
};

/** Reads apps/api/.env only. The repository root has the old prototype's .env, with its own port. */
function loadEnvFiles(): void {
  const file = path.join(ROOT, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function developmentKey(dataDir: string): string {
  const file = path.join(dataDir, "dev-encryption.key");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  fs.mkdirSync(dataDir, { recursive: true });
  const key = generateEncryptionKey();
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, options: { readEnvFiles?: boolean } = {}): Config {
  if (options.readEnvFiles !== false && source === process.env) loadEnvFiles();
  const blanksRemoved = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = Env.safeParse(blanksRemoved);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuration is not valid. ${problems}`);
  }
  const env = parsed.data;
  const production = env.NODE_ENV === "production";

  let encryptionKey = env.MAKEGOOD_ENCRYPTION_KEY;
  let encryptionKeySource: Config["encryptionKeySource"] = "environment";
  if (!encryptionKey) {
    if (production) throw new Error("MAKEGOOD_ENCRYPTION_KEY is required in production.");
    encryptionKey = env.NODE_ENV === "test" ? generateEncryptionKey() : developmentKey(env.DATA_DIR);
    encryptionKeySource = "generated-for-development";
  }
  const partner =
    env.PAYPAL_PARTNER_CLIENT_ID && env.PAYPAL_PARTNER_CLIENT_SECRET
      ? { clientId: env.PAYPAL_PARTNER_CLIENT_ID, clientSecret: env.PAYPAL_PARTNER_CLIENT_SECRET }
      : null;

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    publicUrl: env.PUBLIC_URL.replace(/\/$/, ""),
    databaseUrl: env.DATABASE_URL ?? null,
    dataDir: env.DATA_DIR,
    encryptionKey,
    encryptionKeySource,
    workerInline: env.WORKER_INLINE ?? !production,
    allowSimulator: env.ALLOW_SIMULATOR ?? !production,
    allowLivePayPal: env.ALLOW_LIVE_PAYPAL === LIVE_PAYPAL_PHRASE,
    paypalPartner: partner,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    model: env.MAKEGOOD_MODEL,
    gemini: env.GEMINI_API_KEY ? { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL } : null,
    email: { transport: env.EMAIL_TRANSPORT, resendApiKey: env.RESEND_API_KEY ?? null, from: env.EMAIL_FROM },
    fxApiUrl: env.FX_API_URL.replace(/\/$/, ""),
    logLevel: env.LOG_LEVEL,
  };
}
