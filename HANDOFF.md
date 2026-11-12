# Make Good: hand-off

Read this first. It is the shortest path to working on the project. Update the "Work queue" and "Last session" sections at the end of every session.

## What it is

A PayPal hackathon project. When a supplier recalls one batch of a product, Make Good works out who is owed money, why, how much, and what was actually paid. Flagship story: batch K-0719 of the CM-412 mug set.

## Where things are

| Path | What |
|---|---|
| `apps/api/` | The platform backend. Fastify, TypeScript run directly by Node 24 (no build), PostgreSQL via PGlite locally. Port 4000. |
| `apps/web/` | **The web app** (branch `production-grade`). Incident steps are tabs under `src/app/(app)/incidents/[id]/` (notice, customers, evidence, options, approval, payments, activity); shared data in `src/lib/incident-context.tsx`; the customer page is `src/app/confirm/[token]`. Stack: Next.js 16, React 19, TypeScript, Tailwind 4, shadcn-style components in `src/components/ui`, TanStack Query. `/api/*` is forwarded to the API (`next.config.ts`). Port 3000. |
| `packages/shared/` | Types shared by API and web (`Me`, roles, `formatMoney`). TypeScript source, no build. |
| `e2e/`, `playwright.config.ts` | Browser tests: `foundation.spec.ts` (sign-up, sign-in, guard, demo), `recall.spec.ts` (the whole recall case, 1 minute) and `workspace.spec.ts` (open an incident, connections, team roles, settings, workspace switch). Start their own API (4100, AI off) and web (3100). Edge locally, Chromium in CI. |
| `scripts/dev.mjs`, `scripts/start.mjs` | Run API and web together (dev; production with the API private on 4001). |
| `apps/api/db/migrations/` | `0001` to `0004`. Applied files are never edited; add `0005_…`. |
| `render.yaml` | Render Blueprint: one web service (`npm start`: Next.js public, API private) and free Postgres. Simulator on. Asks for `GEMINI_API_KEY`. Not yet deployed. |
| `docs/CHECKLIST.md` | Status of everything, with evidence. Change it only after something ran and passed. |
| `docs/` others | `STRATEGY.md`, `DEMO.md`, `ARCHITECTURE.md`, `PAYPAL.md`, `VERIFICATION.md` |
| `docs/PRODUCTION-GAPS.md` | Everything between this build and a production-grade product, with severity. The work plan follows it. |

Key backend modules (`apps/api/src/modules/`):

| Module | Start here |
|---|---|
| `matching/` | `types.ts` (`decide`, the two answers), `engine.ts` (pure, `runMatch`) |
| `incidents/service.ts` | `runIncidentMatch`, `decideCandidates`, `reconcilePayment` |
| `execution/` | `batches.ts` (preview, create, revise, approve, start), `manifests.ts` (immutable list, drift, worker guard), `executor.ts` (calls PayPal) |
| `recovery/map.ts` | Recovery Map, `comparePolicies`, `findLookalikes` |
| `evidence/` | `extract.ts` (readers + check), `ai.ts` (prompts and answer shapes), `gemini.ts` (the Gemini client), `service.ts` |
| `evaluation/service.ts` | Accuracy against known answers |
| `notify/` | `mailer.ts` (file outbox), `notices.ts` (batch-code request email, "you were paid" email) |
| `demo/recall-scenario.ts` | The 32-order synthetic recall case, used by simulator and sandbox |
| `paypal/` | `rest-client.ts`, `simulator.ts`, `connections.ts` |
| `api/routes.ts` | Every HTTP route |

## Commands

Repository root (npm workspaces; one `package-lock.json` at the root, `npm install` there):

| Command | Use |
|---|---|
| `npm run dev` | API (4000) and web app (3000) together. Open http://localhost:3000. |
| `npm run typecheck` / `npm run lint` / `npm run format` | All workspaces. CI runs the same. |
| `npx playwright test` | Browser tests for the web app (10 tests, about 2 minutes, Edge). Must pass before every commit that touches the page. |
| `npm run build` then `npm start` | Production build and start, as on Render. |

In `apps/api`:

| Command | Use |
|---|---|
| `npm test` | 120 tests, about 2 minutes. Must pass before every commit. |
| `npx tsc --noEmit` | Type check |
| `npm start` | Server and page at http://localhost:4000. "Open the recall case" loads the demo. |
| `npm run sandbox:recall` | The recall case on the real PayPal sandbox. About 8 minutes: run it in the background. |
| `npm run ai:verify` | The three AI steps against the real model in `.env`. About 1 minute. |

## Rules that must hold

1. Commit after every verified step. This repo commits as `shdra06` through **local** git config only. Never touch the global git config. Before a push, check the authors of unpushed commits and that the stored credential user is `shdra06`.
2. Keys live in `.env` files typed by the owner. Read them by variable name only; never print values.
3. Sandbox only. Live PayPal is off and stays off.
4. Simulator, sandbox and synthetic data are always labelled. Never report a simulator result as PayPal's.
5. AI reads and proposes. It never decides who is paid, approves, or moves money.
6. No fake success. If it did not run, say so.

## Machine quirks (Windows, Git Bash)

- A Bash heredoc with an odd number of apostrophes fails. Write the script to a file, then run it.
- `cd` in a Bash call moves the session folder. Use absolute paths.
- npm downloads drop on this network; `--prefer-offline` helps.
- No Docker and no PostgreSQL server installed.
- Browser pane clicks can fail; drive the page with JavaScript.

## Status (11 Nov 2026)

Built and verified: two-question matching, approval manifests, Recovery Map, policy pricing, evidence reading by pattern rules, the synthetic data set, accuracy measurement, the page, and the whole case on the PayPal sandbox (16 real refunds). Details: `docs/CHECKLIST.md`, `docs/VERIFICATION.md`.

AI: Gemini only (Claude was removed on 11 Nov 2026). Used when `GEMINI_API_KEY` is set in `apps/api/.env`; without it, pattern rules read the notice. The three AI steps are verified on real Gemini with `npm run ai:verify`. The free key hits its daily limit (HTTP 429) after many runs. Not verified: open disputes, Transaction Search, webhooks.

## Work queue

Do these in order. Tick each when it is tested, committed and pushed. Item 5 is extra screens, not the core idea; 7 needs a test store; 8 is mostly covered by the customer link.

- [x] 1. CSV order upload: `commerce/csv.ts`, `POST /stores/:storeId/orders/csv`, `test/csv.test.ts`, and the upload box in Question 2 (checks the file, then Import). Sample: `demo/sample-orders.csv`
- [x] 2. Buyer link: `incidents/confirm.ts`, `/api/public/confirm/:token`, the page at `/?confirm=<token>`, button in the record drawer. The answer is evidence only; staff still decide. Checked in a browser
- [x] 3. `Dockerfile` and `.github/workflows/ci.yml` written. **Neither has run**: no Docker here; check the first CI run on GitHub
- [x] 4. Browser test in Microsoft Edge: `npm run test:e2e` (about 1 minute, AI off). `npm run demo:capture` records `demo/video/make-good-demo.mp4` (about 4 minutes, captions, real AI; not in git) and `demo/screens/*.png` (in git). Needs Edge and ffmpeg, so it is not in CI
- [ ] 5. Other merchant screens: dashboard, monitoring, currencies, settings (API exists)
- [x] 6. Email notices, file transport only (`.data/outbox/*.eml`): "Email the customer a link" in the record drawer, "Email the customers PayPal has paid" in Question 7 (only PayPal-confirmed payments, once each, test label in the subject). `test/notices.test.ts`, browser test. Not built: real sending (Resend)
- [ ] 7. Shopify or WooCommerce connector (needs a test store)
- [ ] 8. Claims portal with evidence upload

Blocked on the owner:

- [x] AI key: Gemini key in `apps/api/.env`, verified. Rotate it: it was pasted in a chat
- [ ] Switch on Transaction Search for the PayPal app, then verify sync
- [ ] Interview 3 to 5 shop owners (`docs/STRATEGY.md` section 5)
- [x] New demo video of the new web app: `demo/video/make-good-submission.mp4` (2 min 52 s, voice-over, AI off). Remake: `demo/VIDEO-PLAN.md` (`node demo/video-src/record.ts`)

Sponsor features (built on `sponsor-features`; merged into `production-grade` and `main` and deployed to Render on 12 Nov 2026, commit 39b8f4d):

- [x] Bryntum recall timeline: Timeline step, `GET …/timeline` (`recovery/timeline.ts`). Bryntum Scheduler **Community 8.0.1 (MIT)** only, read only; no paid-tier features. Batch windows, mixed stock, ship dates, PayPal 180-day refund windows. Tests: `test/timeline.test.ts`, the recall browser test
- [x] Channel3 replacement value: panel on the Options step, `…/catalog`, `…/catalog/search`, `…/catalog/confirm` (`modules/catalog/`), migration 0011 (rows never change). A person confirms the product; the median new in-stock price can price a "fixed per unit" option (dry run). Verified on the real Channel3 API on 12 Nov 2026 with `npm run catalog:verify` (search, product detail, confirm, audit, pricing a dry-run option; no money moved) and in the browser. Key in `apps/api/.env` of this worktree. Many products have offers from only 1 or 2 retailers, so the median can rest on one shop: the screen shows the count. Rotate the key: it was pasted in a chat
- [x] Merged (fast-forward, no conflicts) and live: `/api/health` ok, the timeline and catalogue routes answer on https://make-good.onrender.com. `CHANNEL3_API_KEY` set in the Render dashboard by the owner. The two screens were not opened on the live site by Claude (no account there)
- [ ] Channel3 Recall Radar (offer.deleted webhooks, Svix-signed, US/USD only): not built; needs the key and a public webhook URL

Known loose end: another session's `integration/proposed-0002_…sql` (outside this repo) must become `0003` if it is ever applied.

## Last session

12 Nov 2026, sponsor session (branch `sponsor-features`, in the worktree `../make-good-sponsors`; the main checkout was in use by another session):
- Research checked against vendor pages: Bryntum 8 has a free MIT tier (packages end in `-community`; `@bryntum/scheduler` is an empty placeholder); time-range shading and AI are paid. Channel3 webhooks are signed (Standard Webhooks); subscriptions US/USD only.
- Channel3 coverage, checked through its public MCP server (no key, search words only): 8 of 10 small brands and 6 of 6 big brands found in the top 3; bare model codes 0 of 4. So searches must use the product name, not a code.
- Built: the Bryntum timeline and the Channel3 replacement-value panel (see the work queue). Bryntum fetched Font Awesome from a CDN, blocked by our CSP; the icons now come from `@bryntum/core-community`.
- Checks: see the commit messages on `sponsor-features`. The real Channel3 REST API was verified later the same day (`npm run catalog:verify`, `.data/catalog-verification.json`). Its REST search found a product from a bare model code (KHM512), unlike the public MCP search.
- Local only: `.claude/dev-sponsors.mjs` runs this worktree on ports 4100/3200 (the e2e tests also use 4100: stop it first).

Earlier, 12 Nov 2026 (branch `production-grade`, also on `main` and live on Render at https://make-good.onrender.com):
- Fixed on the live site: row-level security rules failed on pooled Postgres connections (`invalid input syntax for type uuid: ""`), which broke about one request in three and the job worker. Migration 0008.
- Privacy, terms and "how AI is used" pages (`apps/web/src/app/(legal)`), linked from the footer and sign-up. They are drafts that need a lawyer. Settings has a per-workspace AI switch (`aiEnabled`).
- Error tracking: `platform/error-log.ts` writes server errors and failed jobs to `error_events`, shown on Monitoring; optional `ERROR_WEBHOOK_URL`.
- Backup: Settings, "Download a backup" (`GET /orgs/:orgId/export`), all records as JSON without credentials or tokens. Not a database backup.
- Monitoring screen (findings, differences from PayPal, errors, audit trail) and Analytics screen.
- Email invitations (`identity/invitations.ts`, page `/invite/[token]`); the Team page invites instead of adding directly. Staff alerts (`notify/alerts.ts`) go through the job queue: list waiting for approval, payments finished, critical finding.
- Claims portal (`incidents/claims.ts`): public form `/claim/[slug]` with photos (4 MB, 5 per claim, type checked from content, stored encrypted in Postgres), status page `/claim/status/[token]`, and a Claims tab on each incident for staff.
- Shopify (GraphQL Admin API) and WooCommerce (REST v3) connectors (`commerce/stores.ts`) on the Connections page. Tested against recorded responses only.
- Validation errors now name the field and the reason.
- Tests: 138 API, 17 Playwright. `RATE_LIMIT_SCALE` (ignored in production) lets the browser tests create many accounts.

Not verified: Shopify and WooCommerce against a real store; Resend with a real key; the error webhook with a real Slack or Discord URL. Not done: database backups (needs a paid Render Postgres), uptime checks, billing. The demo video was remade on 12 Nov (see `demo/VIDEO-PLAN.md`).
