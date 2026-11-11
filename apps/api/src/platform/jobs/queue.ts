// A durable job queue kept in PostgreSQL.
//
// Why not Redis: a job that moves money must be created in the same
// transaction as the state change that calls for it. With the queue in the
// same database that is one COMMIT. With a separate queue we would need this
// table anyway, as an outbox, plus a relay. PayPal's rate limits, not the
// queue, set our throughput, so one fewer service to run is the better trade.
//
// Delivery is at-least-once. A job whose worker dies is picked up again when
// its lease runs out, so every handler must be safe to run twice.

import type { Clock } from "../clock.ts";
import type { Db, Queryable } from "../db/db.ts";
import { json } from "../db/db.ts";

export type Job = {
  id: string;
  org_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  run_at: Date;
};

export type JobInput = {
  type: string;
  payload?: Record<string, unknown>;
  orgId?: string | null;
  runAt?: Date;
  /** While a job with this key is waiting or running, another is not added. */
  dedupeKey?: string;
  maxAttempts?: number;
};

/** Adds a job. Pass the transaction that makes the related change. Returns null if deduplicated. */
export async function enqueue(q: Queryable, job: JobInput, now: Date): Promise<string | null> {
  const rows = await q.query<{ id: string }>(
    `insert into jobs (org_id, type, payload, run_at, dedupe_key, max_attempts, created_at)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7)
     on conflict (dedupe_key) where dedupe_key is not null and status in ('queued','running') do nothing
     returning id`,
    [
      job.orgId ?? null,
      job.type,
      json(job.payload ?? {}),
      (job.runAt ?? now).toISOString(),
      job.dedupeKey ?? null,
      job.maxAttempts ?? 10,
      now.toISOString(),
    ],
  );
  return rows[0]?.id ?? null;
}

/** Takes jobs that are due, or whose worker stopped renewing its lease. */
export async function claimJobs(
  db: Db,
  input: { workerId: string; limit: number; leaseMs: number; now: Date; types?: string[] },
): Promise<Job[]> {
  const params: unknown[] = [input.workerId, new Date(input.now.getTime() + input.leaseMs).toISOString(), input.now.toISOString(), input.limit];
  let typeFilter = "";
  if (input.types && input.types.length > 0) {
    typeFilter = `and type in (${input.types.map((_, i) => `$${params.length + i + 1}`).join(", ")})`;
    params.push(...input.types);
  }
  return db.query<Job>(
    `update jobs
        set status = 'running', locked_by = $1, locked_until = $2, attempts = attempts + 1
      where id in (
        select id from jobs
         where ((status = 'queued' and run_at <= $3) or (status = 'running' and locked_until < $3))
           ${typeFilter}
         order by run_at
         limit $4
         for update skip locked)
      returning id, org_id, type, payload, attempts, max_attempts, run_at`,
    params,
  );
}

export async function completeJob(q: Queryable, jobId: string, now: Date): Promise<void> {
  await q.query(
    "update jobs set status = 'succeeded', finished_at = $2, locked_by = null, locked_until = null, last_error = null where id = $1",
    [jobId, now.toISOString()],
  );
}

/** Puts a job back for later. `countAttempt: false` is for planned waits (rate limits), which are not failures. */
export async function rescheduleJob(
  q: Queryable,
  jobId: string,
  input: { runAt: Date; error?: string; countAttempt: boolean },
): Promise<void> {
  await q.query(
    `update jobs
        set status = 'queued', run_at = $2, locked_by = null, locked_until = null, last_error = $3,
            attempts = case when $4::boolean then attempts else greatest(attempts - 1, 0) end
      where id = $1`,
    [jobId, input.runAt.toISOString(), input.error ?? null, input.countAttempt],
  );
}

export async function killJob(q: Queryable, jobId: string, error: string, now: Date): Promise<void> {
  await q.query(
    "update jobs set status = 'dead', finished_at = $3, locked_by = null, locked_until = null, last_error = $2 where id = $1",
    [jobId, error, now.toISOString()],
  );
}

/** Thrown by a handler to say "not now, try at this time". Not counted as a failure. */
export class RetryLater extends Error {
  readonly delayMs: number;
  constructor(delayMs: number, reason: string) {
    super(reason);
    this.name = "RetryLater";
    this.delayMs = delayMs;
  }
}

export type JobHandler = (job: Job) => Promise<void>;

export type RunnerOptions = {
  workerId: string;
  clock: Clock;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  onError?: (job: Job, err: unknown) => void;
};

/** Exponential backoff with a ceiling: 15 s, 30 s, 1 min ... up to 1 hour. */
export function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
}

export class JobRunner {
  readonly #db: Db;
  readonly #handlers: Map<string, JobHandler>;
  readonly #options: Required<Omit<RunnerOptions, "onError">> & Pick<RunnerOptions, "onError">;
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  #stopped = true;

  constructor(db: Db, handlers: Record<string, JobHandler>, options: RunnerOptions) {
    this.#db = db;
    this.#handlers = new Map(Object.entries(handlers));
    this.#options = { concurrency: 4, leaseMs: 120_000, pollMs: 500, ...options };
  }

  /** Claims and runs one round of due jobs. Returns how many ran. */
  async runOnce(): Promise<number> {
    const { clock, workerId, concurrency, leaseMs } = this.#options;
    const jobs = await claimJobs(this.#db, { workerId, limit: concurrency, leaseMs, now: clock.now(), types: [...this.#handlers.keys()] });
    await Promise.all(jobs.map((job) => this.#run(job)));
    return jobs.length;
  }

  async #run(job: Job): Promise<void> {
    const { clock } = this.#options;
    const handler = this.#handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler for job type "${job.type}".`);
      await handler(job);
      await completeJob(this.#db, job.id, clock.now());
    } catch (err) {
      const now = clock.now();
      if (err instanceof RetryLater) {
        await rescheduleJob(this.#db, job.id, { runAt: new Date(now.getTime() + err.delayMs), error: err.message, countAttempt: false });
        return;
      }
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.#options.onError?.(job, err);
      if (job.attempts >= job.max_attempts) await killJob(this.#db, job.id, message, now);
      else await rescheduleJob(this.#db, job.id, { runAt: new Date(now.getTime() + backoffMs(job.attempts)), error: message, countAttempt: true });
    }
  }

  /** Runs until nothing is due. For tests and one-shot commands. */
  async drain(maxRounds = 1000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const ran = await this.runOnce();
      if (ran === 0) return total;
      total += ran;
    }
    throw new Error("The job queue did not settle. A job may be rescheduling itself for the same instant.");
  }

  start(): void {
    this.#stopped = false;
    const tick = async () => {
      if (this.#stopped) return;
      if (!this.#busy) {
        this.#busy = true;
        try {
          while (!this.#stopped && (await this.runOnce()) > 0) {
            // keep going while there is work
          }
        } catch (err) {
          this.#options.onError?.({ id: "", org_id: null, type: "runner", payload: {}, attempts: 0, max_attempts: 0, run_at: new Date() }, err);
        } finally {
          this.#busy = false;
        }
      }
      this.#timer = setTimeout(tick, this.#options.pollMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    while (this.#busy) await new Promise((r) => setTimeout(r, 20));
  }
}
