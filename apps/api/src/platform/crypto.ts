// Passwords, tokens and secrets at rest. Only Node's built-in crypto is used.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

// ---------- passwords (scrypt) ----------

export type ScryptCost = { N: number; r: number; p: number };

/** Interactive-login cost. Tests pass a cheaper cost to stay fast. */
export const DEFAULT_SCRYPT_COST: ScryptCost = { N: 2 ** 15, r: 8, p: 1 };

function scryptAsync(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { ...cost, maxmem: 128 * cost.N * cost.r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string, cost: ScryptCost = DEFAULT_SCRYPT_COST): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const cost = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  if (![cost.N, cost.r, cost.p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  const actual = await scryptAsync(password, salt, cost);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- tokens ----------

/** A random token for the holder, and the hash we store. The token itself is never stored. */
export function newToken(bytes = 32): { token: string; hash: string } {
  const token = randomBytes(bytes).toString("base64url");
  return { token, hash: sha256Hex(token) };
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(key: string | Buffer, value: string | Buffer): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A short code a person can read out, e.g. "MG-7K2Q-9XPD". Not a secret. */
export function publicRef(prefix: string): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CROCKFORD[(bytes[i] ?? 0) % 32];
  return `${prefix}-${out.slice(0, 4)}-${out.slice(4)}`;
}

// ---------- secrets at rest (AES-256-GCM) ----------

/**
 * Encrypts integration secrets (PayPal client secrets, store API keys) before
 * they are written to the database. The key comes from the environment and is
 * never stored next to the data. The key ID in each value allows rotation.
 */
export class SecretBox {
  readonly #keys: Map<string, Buffer>;
  readonly #currentKeyId: string;

  constructor(keys: Record<string, string>, currentKeyId: string) {
    this.#keys = new Map();
    for (const [id, encoded] of Object.entries(keys)) {
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes, base64 encoded.`);
      this.#keys.set(id, key);
    }
    if (!this.#keys.has(currentKeyId)) throw new Error(`Encryption key "${currentKeyId}" is not configured.`);
    this.#currentKeyId = currentKeyId;
  }

  encrypt(plaintext: string): string {
    const key = this.#keys.get(this.#currentKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", this.#currentKeyId, iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
  }

  decrypt(value: string): string {
    const [version, keyId, iv, tag, body] = value.split(".");
    if (version !== "v1" || !keyId || !iv || !tag || body === undefined) throw new Error("Unreadable secret.");
    const key = this.#keys.get(keyId);
    if (!key) throw new Error(`Secret was encrypted with key "${keyId}", which is not configured.`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

/** Shows only the last characters of an identifier, for screens and logs. */
export function maskTail(value: string | null | undefined, keep = 4): string {
  if (!value) return "";
  return value.length <= keep ? "*".repeat(value.length) : `${"*".repeat(Math.min(8, value.length - keep))}${value.slice(-keep)}`;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, Math.min(6, local.length - 1)))}@${domain}`;
}
