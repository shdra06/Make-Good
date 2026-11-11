import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The project folder, wherever the server was started from. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env if present (built into Node; no dotenv dependency).
if (fs.existsSync(path.join(ROOT, ".env"))) {
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    // a malformed .env is ignored; real environment variables still apply
  }
}

const env = (k: string) => (process.env[k] ?? "").trim();

export const config = {
  port: Number(env("PORT") || 3000),
  publicUrl: env("PUBLIC_URL") || `http://localhost:${env("PORT") || 3000}`,
  dbPath: path.resolve(ROOT, env("MAKEGOOD_DB") || "data/makegood.db"),
  paypal: {
    clientId: env("PAYPAL_CLIENT_ID"),
    clientSecret: env("PAYPAL_CLIENT_SECRET"),
    webhookId: env("PAYPAL_WEBHOOK_ID"),
    // Hard-coded on purpose: Make Good only ever talks to the sandbox.
    baseUrl: "https://api-m.sandbox.paypal.com",
    testCard: {
      number: env("PAYPAL_TEST_CARD_NUMBER"),
      expiry: env("PAYPAL_TEST_CARD_EXPIRY"),
      cvv: env("PAYPAL_TEST_CARD_CVV"),
    },
  },
  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY"),
    model: env("MAKEGOOD_MODEL") || "claude-opus-5-5",
  },
};

export type PayPalMode = "mock" | "sandbox";
export type AiMode = "mock" | "claude";

export const paypalMode: PayPalMode =
  config.paypal.clientId && config.paypal.clientSecret && env("MAKEGOOD_FORCE_MOCK") !== "1" ? "sandbox" : "mock";

export const aiMode: AiMode = config.anthropic.apiKey && env("MAKEGOOD_FORCE_MOCK_AI") !== "1" ? "claude" : "mock";

/** PayPal's documented refund window, in days. Older payments are routed to a payout. */
export const REFUND_WINDOW_DAYS = 180;
