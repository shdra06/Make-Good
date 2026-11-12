// Error tracking. Server errors and failed background jobs are written to the
// error_events table (shown on the Monitoring screen) and, when ERROR_WEBHOOK_URL
// is set, posted there as JSON (Slack, Discord or any endpoint that takes JSON).
// Recording an error never throws: tracking must not cause a second failure.

import type { Queryable } from "./db/db.ts";

export type ErrorEvent = { source: "request" | "job"; where: string; orgId?: string | null; error: unknown };

const MAX_MESSAGE = 1000;
const MAX_DETAIL = 2000;
const uuidish = /^[0-9a-f-]{36}$/i;

export function createErrorLog(input: { db: Queryable; webhookUrl: string | null; fetchImpl?: typeof fetch; now: () => Date }) {
  const send = input.fetchImpl ?? fetch;
  return async function record(event: ErrorEvent): Promise<void> {
    const err = event.error;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_MESSAGE);
    const detail = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 8).join("\n").slice(0, MAX_DETAIL) : null;
    const orgId = event.orgId && uuidish.test(event.orgId) ? event.orgId : null;
    const at = input.now().toISOString();
    try {
      await input.db.query("insert into error_events (org_id, source, where_, message, detail, created_at) values ($1, $2, $3, $4, $5, $6)", [
        orgId, event.source, event.where.slice(0, 300), message, detail, at,
      ]);
    } catch {
      // The database may be what failed. The log line from the caller still exists.
    }
    if (input.webhookUrl) {
      const text = `Make Good error (${event.source}) at ${event.where}: ${message}`;
      await send(input.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // "text" is read by Slack, "content" by Discord; the rest is for anything else.
        body: JSON.stringify({ text, content: text, source: event.source, where: event.where, orgId, message, at }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
    }
  };
}

export type ErrorLog = ReturnType<typeof createErrorLog>;
