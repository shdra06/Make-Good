// Customer personal data at rest: names and email addresses of shoppers and
// PayPal payers, and the raw order and payment payloads that contain them.
//
// - seal():  AES-256-GCM with a random IV. Stored as "pii1:<base64url>". The same
//            value sealed twice looks different, so a copy of the database shows nothing.
// - index(): a keyed hash (HMAC-SHA-256) of a normalised value, stored as "h1:<hex>".
//            Equal emails give equal indexes, so orders can still be joined to
//            PayPal payments by email without the email being readable.
//
// Reading is automatic: the database layer opens every "pii1:" value in every
// row it returns (see db.ts), so the rest of the code sees plain text.
// Both keys are derived from MAKEGOOD_ENCRYPTION_KEY; losing it loses the data.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const SEALED = "pii1:";
const INDEXED = "h1:";

export class Pii {
  readonly #enc: Buffer;
  readonly #idx: Buffer;

  constructor(masterKey: string | Buffer) {
    const ikm = typeof masterKey === "string" ? Buffer.from(masterKey, "base64") : masterKey;
    if (ikm.length < 32) throw new Error("The key for customer data must be at least 32 bytes.");
    this.#enc = Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), "make-good customer data encryption v1", 32));
    this.#idx = Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), "make-good customer data index v1", 32));
  }

  /** A random key, for in-memory databases (tests, scripts) whose data does not outlive the process. */
  static ephemeral(): Pii {
    return new Pii(randomBytes(32));
  }

  seal(value: string): string;
  seal(value: string | null | undefined): string | null;
  seal(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === "") return value ?? null;
    if (value.startsWith(SEALED)) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#enc, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return SEALED + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  open(value: string): string {
    if (!value.startsWith(SEALED)) return value;
    const raw = Buffer.from(value.slice(SEALED.length), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.#enc, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }

  /** A keyed hash of an already-normalised value, for equality lookups. */
  index(normalised: string | null | undefined): string | null {
    if (!normalised) return null;
    if (normalised.startsWith(INDEXED)) return normalised;
    return INDEXED + createHmac("sha256", this.#idx).update(normalised, "utf8").digest("hex");
  }

  /** The index of an email address: trimmed, lower case, then hashed. */
  emailIndex(email: string | null | undefined): string | null {
    return email ? this.index(email.trim().toLowerCase()) : null;
  }

  /** A JSON payload as one sealed string. Used for raw provider and store payloads, which nothing reads back. */
  sealJson(value: unknown): string {
    return JSON.stringify(this.seal(JSON.stringify(value ?? null)));
  }

  /** Opens every sealed string field of the rows, in place. */
  openRows<T>(rows: T[]): T[] {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      for (const key in record) {
        const v = record[key];
        if (typeof v === "string" && v.startsWith(SEALED)) record[key] = this.open(v);
      }
    }
    return rows;
  }
}

export const isSealed = (value: unknown): boolean => typeof value === "string" && value.startsWith(SEALED);
export const isIndexed = (value: unknown): boolean => typeof value === "string" && value.startsWith(INDEXED);
