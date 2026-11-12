import fs from "node:fs/promises";
import path from "node:path";

/** The newest link of one kind in the emails the test API wrote for this address (DATA_DIR/outbox). */
export async function linkFor(email: string, kind: "verify-email" | "reset-password" | "invite"): Promise<string> {
  const outbox = path.join(process.env.MG_E2E_DATA_DIR!, "outbox");
  for (let attempt = 0; attempt < 20; attempt++) {
    const names = (await fs.readdir(outbox).catch(() => [] as string[])).sort().reverse();
    for (const name of names) {
      const text = await fs.readFile(path.join(outbox, name), "utf8");
      if (!text.toLowerCase().includes(`to: ${email.toLowerCase()}`)) continue;
      const match = text.match(new RegExp(String.raw`https?://\S+/${kind}/[A-Za-z0-9_-]+`));
      if (match) return new URL(match[0]).pathname;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No ${kind} email for ${email}`);
}
