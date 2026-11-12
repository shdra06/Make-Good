// The HTTP layer: one place where every request is authenticated, authorised,
// validated and turned into a reply.
//
// A route is declared once, with its permission and its Zod schemas. From that
// single declaration come: the input check, the tenant check, the permission
// check, and the OpenAPI description served at /api/openapi.json.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { Config } from "../platform/config.ts";
import { AppError, ForbiddenError, RateLimitedError, UnauthenticatedError } from "../platform/errors.ts";
import {
  requireMembership,
  requirePermission,
  userForToken,
  type Deps as IdentityDeps,
  type Membership,
  type Permission,
  type SessionUser,
} from "../modules/identity/service.ts";

export const SESSION_COOKIE = "mg_session";
/** Sent by the web app on every request that changes something. See the CSRF hook below. */
export const CSRF_HEADER = "x-make-good";

export type AuthMode = "public" | "user" | { permission: Permission };

export type RouteContext<B, Q, P> = {
  body: B;
  query: Q;
  params: P;
  /** The signed-in user. Present for every route that is not public. */
  user: SessionUser;
  /** The caller's membership of the organisation in the path. Present for routes with a permission. */
  org: Membership;
  req: FastifyRequest;
  reply: FastifyReply;
  ip: string;
};

export type RouteSpec<B extends z.ZodType, Q extends z.ZodType, P extends z.ZodType> = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  tag: string;
  auth: AuthMode;
  body?: B;
  query?: Q;
  params?: P;
  rateLimit?: { max: number; windowMs: number };
  handler: (ctx: RouteContext<z.infer<B>, z.infer<Q>, z.infer<P>>) => Promise<unknown>;
};

type Registered = Pick<RouteSpec<z.ZodType, z.ZodType, z.ZodType>, "method" | "path" | "summary" | "tag" | "auth" | "body" | "query" | "params">;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string | null, expiresAt: Date | null, secure: boolean): string {
  const base = `${SESSION_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return token && expiresAt ? `${base}; Expires=${expiresAt.toUTCString()}` : `${base}; Max-Age=0`;
}

/** A small in-memory limiter. It is per process: put a shared one in front when running several instances. */
class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  check(key: string, max: number, windowMs: number, now: number): void {
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) throw new RateLimitedError(Math.ceil((windowMs - (now - recent[0]!)) / 1000));
    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > 50_000) this.#hits.clear();
  }
}

export type Router = {
  app: FastifyInstance;
  route<B extends z.ZodType = z.ZodUndefined, Q extends z.ZodType = z.ZodUndefined, P extends z.ZodType = z.ZodUndefined>(
    spec: RouteSpec<B, Q, P>,
  ): void;
  openapi(): Record<string, unknown>;
};

export function createRouter(input: { config: Config; identity: IdentityDeps; now: () => Date }): Router {
  const { config, identity } = input;
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });
  const limiter = new RateLimiter();
  const registry: Registered[] = [];

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Cache-Control", "no-store");
    // The API serves JSON only: nothing in a reply may run, load or be framed.
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    if (config.env === "production") reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  });

  // Cross-site request forgery. Browsers attach cookies to requests from other
  // sites, so a request that changes something must prove it came from our own
  // pages, in two ways:
  // 1. It carries the header CSRF_HEADER. A page on another site cannot add a
  //    custom header without a CORS preflight, and this API answers no preflight.
  // 2. If the browser names an origin, it is ours.
  // Webhooks and the public customer API carry no session and are checked in their own way.
  app.addHook("onRequest", async (req) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    if (req.url.startsWith("/api/webhooks/") || req.url.startsWith("/api/public/")) return;
    if (req.headers[CSRF_HEADER] !== "1") throw new ForbiddenError(`Requests that change something must send the header ${CSRF_HEADER}: 1.`);
    const origin = req.headers.origin;
    if (!origin) return; // not a browser
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new ForbiddenError("The request came from an unknown origin.");
    }
    const allowed = new Set([req.headers.host, new URL(config.publicUrl).host]);
    if (config.env !== "production") ["localhost:5173", "127.0.0.1:5173", "localhost:4100"].forEach((h) => allowed.add(h));
    if (!allowed.has(host)) throw new ForbiddenError("The request came from another site.");
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "Some of the information sent is not valid.",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (err instanceof AppError) {
      if (err instanceof RateLimitedError) reply.header("Retry-After", String((err.details as { retryAfterSeconds: number }).retryAfterSeconds));
      return reply.code(err.httpStatus).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "BAD_REQUEST", message: (err as Error).message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Something went wrong on our side." } });
  });

  const empty = undefined as never;

  function route<B extends z.ZodType, Q extends z.ZodType, P extends z.ZodType>(spec: RouteSpec<B, Q, P>): void {
    registry.push(spec as unknown as Registered);
    app.route({
      method: spec.method,
      url: spec.path,
      handler: async (req, reply) => {
        const ip = req.ip;
        if (spec.rateLimit) limiter.check(`${spec.method} ${spec.path} ${ip}`, spec.rateLimit.max, spec.rateLimit.windowMs, input.now().getTime());

        let user: SessionUser | null = null;
        let org: Membership | null = null;
        if (spec.auth !== "public") {
          user = await userForToken(identity, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
          if (!user) throw new UnauthenticatedError();
          if (typeof spec.auth === "object") {
            const orgId = (req.params as Record<string, string>).orgId ?? "";
            org = await requireMembership(identity, user.id, orgId);
            requirePermission(org, spec.auth.permission);
          }
        }
        const result = await spec.handler({
          body: spec.body ? spec.body.parse(req.body ?? {}) : empty,
          query: spec.query ? spec.query.parse(req.query ?? {}) : empty,
          params: spec.params ? spec.params.parse(req.params ?? {}) : empty,
          user: user as SessionUser,
          org: org as Membership,
          req,
          reply,
          ip,
        });
        if (reply.sent) return;
        if (result === undefined) return reply.code(204).send();
        return reply.send(result);
      },
    });
  }

  function openapi(): Record<string, unknown> {
    const schemaOf = (schema: z.ZodType | undefined): Record<string, unknown> | null => {
      if (!schema) return null;
      try {
        return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const paths: Record<string, Record<string, unknown>> = {};
    for (const r of registry) {
      const path = r.path.replace(/:([A-Za-z]+)/g, "{$1}");
      const parameters: unknown[] = [];
      for (const [where, schema] of [["path", r.params], ["query", r.query]] as const) {
        const props = (schemaOf(schema)?.properties ?? {}) as Record<string, unknown>;
        for (const [name, s] of Object.entries(props)) parameters.push({ name, in: where, required: where === "path", schema: s });
      }
      for (const name of [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!)) {
        if (!parameters.some((p) => (p as { name: string; in: string }).name === name && (p as { in: string }).in === "path")) {
          parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
        }
      }
      const body = schemaOf(r.body);
      (paths[path] ??= {})[r.method.toLowerCase()] = {
        summary: r.summary,
        tags: [r.tag],
        parameters,
        ...(body ? { requestBody: { required: true, content: { "application/json": { schema: body } } } } : {}),
        security: r.auth === "public" ? [] : [{ session: [] }],
        "x-permission": typeof r.auth === "object" ? r.auth.permission : undefined,
        responses: {
          "200": { description: "OK" },
          "401": { description: "Not signed in" },
          "403": { description: "Not allowed for this role" },
          "404": { description: "Not found, or not in your organisation" },
          "422": { description: "Validation failed" },
        },
      };
    }
    return {
      openapi: "3.1.0",
      info: { title: "Make Good API", version: "0.2.0", description: "Merchant remediation on PayPal. All amounts are integer minor units." },
      servers: [{ url: config.publicUrl }],
      components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: SESSION_COOKIE } } },
      paths,
    };
  }

  return { app, route, openapi };
}

export const OrgParams = z.object({ orgId: z.string().uuid() });
export const uuid = z.string().uuid();
export const Paging = z.object({ page: z.coerce.number().int().min(1).optional(), size: z.coerce.number().int().min(1).max(200).optional() });
