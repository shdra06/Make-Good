// Where emails go.
//   file:   each email is written to DATA_DIR/outbox as a .eml file that any
//           mail program can open. Nothing is sent. For local work and tests.
//   resend: sent through Resend's API (https://resend.com). Needs RESEND_API_KEY
//           and an EMAIL_FROM address on a domain verified with Resend.

import fs from "node:fs/promises";
import path from "node:path";

export type Email = { id: string; to: string; subject: string; text: string; at: Date };

export interface Mailer {
  readonly transport: "file" | "resend";
  send(email: Email): Promise<{ ref: string }>;
}

const NL = String.fromCharCode(13, 10);
// A header value never carries a line break.
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export class FileMailer implements Mailer {
  readonly transport = "file" as const;
  readonly #dir: string;
  readonly #from: string;
  constructor(opts: { dir: string; from: string }) {
    this.#dir = opts.dir;
    this.#from = opts.from;
  }
  async send(email: Email): Promise<{ ref: string }> {
    await fs.mkdir(this.#dir, { recursive: true });
    const name = `${email.at.toISOString().replace(/[:.]/g, "-")}-${email.id}.eml`;
    const headers = [
      `From: ${oneLine(this.#from)}`,
      `To: ${oneLine(email.to)}`,
      `Subject: ${oneLine(email.subject)}`,
      `Date: ${email.at.toUTCString()}`,
      `Message-ID: <${email.id}@make-good.local>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
    ];
    await fs.writeFile(path.join(this.#dir, name), headers.join(NL) + NL + NL + email.text.split(/\r?\n/).join(NL) + NL, "utf8");
    return { ref: `outbox/${name}` };
  }
}

/** Sends through Resend. The email's own ID is the idempotency key, so a retry never sends it twice. */
export class ResendMailer implements Mailer {
  readonly transport = "resend" as const;
  readonly #key: string;
  readonly #from: string;
  readonly #fetch: typeof fetch;
  constructor(opts: { apiKey: string; from: string; fetchImpl?: typeof fetch }) {
    this.#key = opts.apiKey;
    this.#from = opts.from;
    this.#fetch = opts.fetchImpl ?? fetch;
  }
  async send(email: Email): Promise<{ ref: string }> {
    const res = await this.#fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json", "Idempotency-Key": email.id },
      body: JSON.stringify({ from: oneLine(this.#from), to: [oneLine(email.to)], subject: oneLine(email.subject), text: email.text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok || !body.id) throw new Error(`Resend refused the email (HTTP ${res.status}${body.name ? `, ${body.name}` : ""}): ${body.message ?? "no reason given"}`);
    return { ref: `resend/${body.id}` };
  }
}
