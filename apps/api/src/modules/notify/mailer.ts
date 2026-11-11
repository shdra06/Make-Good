// Where customer emails go. Only the file transport exists: each email is
// written to DATA_DIR/outbox as a .eml file that any mail program can open.
// Nothing is sent over the internet.

import fs from "node:fs/promises";
import path from "node:path";

export type Email = { id: string; to: string; subject: string; text: string; at: Date };

export interface Mailer {
  readonly transport: "file";
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
