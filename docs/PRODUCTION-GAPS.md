# Make Good: what stands between this and a production-grade product

Written 11 Nov 2026 on branch `production-grade`. No deadline is assumed. Every shortcut is listed, whatever the reason for it.

Each item says **why** it is the way it is:

- **Shortcut**: done the quick way, mostly because of the submission date. This is a choice we can now undo.
- **Blocked**: waits on something outside the code (PayPal approval, a test store, a key, real users).
- **Never built**: not started.

Severity: **Critical** (a judge or a real merchant would notice at once, or money or data is at risk), **High**, **Medium**.

---

## 0. The verdict

The owner is right on the main point. The backend is built like a real product. The front end is not: it is one hand-written page, and it is the only thing a judge sees.

One correction: plain HTML, CSS and JavaScript is still used (many fast sites use it). But for a product that will grow to many screens and a team, it is the wrong choice. Choosing it was a mistake made in this project, not a requirement.

---

## 1. The front end (the biggest problem)

| # | Problem | Why | Severity |
|---|---|---|---|
| 1.1 | No framework. The whole interface is `apps/web/public/app.js`, **1,100 lines in one file**, building the page by hand with a small `h()` helper. No React, Next.js, Vue or similar. | Shortcut | **Critical** |
| 1.2 | No TypeScript in the front end. The API is typed; the page is not, so a change to the API can break the page without warning. | Shortcut | High |
| 1.3 | No components. Buttons, tables, cards and the record drawer are rebuilt inline each time. Nothing is reusable or testable alone. | Shortcut | High |
| 1.4 | No routing. One long page. A merchant cannot link to an incident, a customer record or a payment list. The only "route" is `?confirm=<token>`. | Shortcut | High |
| 1.5 | No design system. One CSS file (317 lines) with home-made styles. No component library, no consistent spacing, type or colour scale. | Shortcut | High |
| 1.6 | It is a demo walk-through, not an app. The home page creates a throw-away demo account. There is no real sign-up, onboarding, workspace or navigation. | Shortcut | **Critical** |
| 1.7 | Only one product screen exists (the seven-question recall flow). Missing: dashboard, list of incidents, create an incident, connect PayPal, connect a store, team and roles, settings, payments history, audit view, customer view. The API for many of these exists. | Never built | **Critical** |
| 1.8 | Accessibility is not done. 5 `aria-` attributes in the whole page, no keyboard or screen-reader check, no colour-contrast check. | Never built | High |
| 1.9 | Not checked on phones or tablets. | Never built | Medium |
| 1.10 | No front-end tests apart from one Edge walk-through (`npm run test:e2e`), which is not in CI. | Shortcut | High |
| 1.11 | No loading states, empty states or error pages designed as such; errors appear as a toast. | Shortcut | Medium |
| 1.12 | English only, US dollar formatting in places. | Never built | Medium |

**Fix:** a real web app in `apps/web`: React with TypeScript, built with Vite (or Next.js if we want server rendering and a marketing site in the same app), a component library (for example shadcn/ui on Radix with Tailwind), TanStack Query for API calls, React Router for pages, and types shared with the API from the same Zod schemas. Playwright tests in CI. The backend does not need to change for this.

---

## 2. Product scope

| # | Problem | Why | Severity |
|---|---|---|---|
| 2.1 | Only one kind of problem is shown end to end: a batch recall. The backend also has detectors and other incident kinds that no screen uses. | Shortcut | High |
| 2.2 | Store connectors: Shopify and WooCommerce are named in the database but **not built**. Orders come in only by CSV or by the import API. A real merchant would not type orders into a spreadsheet. | Blocked (needs a test store) | **Critical** |
| 2.3 | Customer emails are saved as files, **not sent**. On a server they are lost at each restart. | Shortcut | High |
| 2.4 | No claims portal where a customer starts a claim and uploads a photo. Only the one-question batch-code link exists. | Never built | Medium |
| 2.5 | No notifications for staff (approval waiting, payment failed). | Never built | Medium |
| 2.6 | No billing, plans or pricing page for merchants. | Never built | Medium |

---

## 3. PayPal

| # | Problem | Why | Severity |
|---|---|---|---|
| 3.1 | **Live PayPal has never run.** Only the simulator and the sandbox. | Blocked (on purpose until it is safe) | **Critical** for real use |
| 3.2 | **Transaction Search is not verified.** It is how real PayPal payments are pulled in to match against orders. Without it, matching only works on data we loaded ourselves. | Blocked (owner must switch it on for the PayPal app) | **Critical** |
| 3.3 | Webhooks: code checks the signature with PayPal's API, but no real webhook has arrived. | Blocked (needs a public address: Render solves it) | High |
| 3.4 | Disputes: the "open dispute" check has not run against real data. | Blocked | High |
| 3.5 | Merchant onboarding (each shop connects its own PayPal) is written for PayPal's partner programme, which needs PayPal's approval. Today one set of keys is used. | Blocked (PayPal approval) | **Critical** for many merchants |
| 3.6 | Payouts (paying customers who did not pay by PayPal) are less tested on the sandbox than refunds. | Shortcut | Medium |
| 3.7 | Currency conversion uses public reference rates, marked "indicative". | Shortcut | Medium |

---

## 4. Security

| # | Problem | Why | Severity |
|---|---|---|---|
| 4.1 | No password reset, no email verification, no two-factor sign-in, no "sign in with Google". | Never built | **Critical** |
| 4.2 | No security headers found in the code (Content-Security-Policy, HSTS and similar). | Never built | High |
| 4.3 | Cross-site request protection relies on the cookie's SameSite=Lax setting only. No CSRF token. | Shortcut | High |
| 4.4 | Rate limits are kept in the memory of one process: lost on restart, not shared between servers. | Shortcut | Medium |
| 4.5 | Tenant separation is done in code (every query filters by organisation). The database does not enforce it (no row-level security). One missed filter would show another shop's customers. | Shortcut | High |
| 4.6 | Customer names and emails are stored in plain text. Only PayPal and store secrets are encrypted. | Shortcut | High |
| 4.7 | Two packages are not pinned to a version (`"*"` for `@fastify/static` and `@fastify/multipart`). | Shortcut | Medium |
| 4.8 | No security review, dependency scanning or penetration test. | Never built | High |
| 4.9 | Anyone can register on a public deployment. Fine for a demo, not for a product. | Shortcut | Medium |

---

## 5. Running it in production

| # | Problem | Why | Severity |
|---|---|---|---|
| 5.1 | One process runs the API and the payment worker. A separate worker exists (`src/worker.ts`) but is not used in `render.yaml`. | Shortcut | Medium |
| 5.2 | Render free plan: sleeps after 15 minutes, free database deleted after 30 days. | Shortcut | High |
| 5.3 | No backups or restore test. | Never built | **Critical** |
| 5.4 | No error tracking, monitoring or alerts (for example Sentry, uptime checks). Logs go to the console only. | Never built | High |
| 5.5 | No staging environment; no deploy pipeline beyond Render's auto-deploy. | Never built | Medium |
| 5.6 | The `Dockerfile` has never been built. | Blocked (no Docker on this machine) | Medium |
| 5.7 | No load testing. Unknown how many orders or payments it handles. | Never built | Medium |
| 5.8 | Not yet deployed anywhere: `render.yaml` is ready, never run on Render. | Not done | High |

---

## 6. Data, privacy and legal

| # | Problem | Why | Severity |
|---|---|---|---|
| 6.1 | No way to export or delete a customer's data on request, and no retention rule. | Never built | High |
| 6.2 | No privacy policy or terms of service. | Never built | High |
| 6.3 | Customer data is sent to Google Gemini when the AI reads records; this is not disclosed to merchants or their customers. | Shortcut | High |

---

## 7. AI

| # | Problem | Why | Severity |
|---|---|---|---|
| 7.1 | Free Gemini key: it hit its daily limit today (HTTP 429). | Shortcut | High |
| 7.2 | The model name `gemini-flash-latest` changes underneath us without notice. | Shortcut | Medium |
| 7.3 | Its accuracy was checked on one invented case only. | Shortcut | Medium |
| 7.4 | The key was pasted into a chat and must be replaced. | Not done | High |

---

## 8. Proof that anyone needs it

| # | Problem | Why | Severity |
|---|---|---|---|
| 8.1 | All data is invented. The accuracy figures are measured against answers we wrote. | Shortcut | High |
| 8.2 | No shop owner has been interviewed or has tried it. | Blocked (owner) | **Critical** for judges who ask "who wants this?" |

---

## 9. The repository

| # | Problem | Why | Severity |
|---|---|---|---|
| 9.1 | The first prototype still sits at the root (`src/`, `public/`, `test/`, root `package.json`): 19 files beside `apps/`. A new teammate cannot tell which is the product. | Shortcut | High |
| 9.2 | Not a proper monorepo: no shared workspace, no shared types package, no single lint and format setup. | Shortcut | Medium |
| 9.3 | No linter or formatter rules enforced in CI. | Never built | Medium |
| 9.4 | The API routes are one 734-line file. | Shortcut | Medium |
| 9.5 | Many documents, some overlapping (`README`, `HANDOFF`, `CHECKLIST`, `VERIFICATION`, `ARCHITECTURE`, `STRATEGY`, `DEMO`). | Shortcut | Medium |

---

## 10. What is already production-grade (keep it)

- Payment safety: every PayPal call has a fixed request ID, a lost reply is asked again instead of resent, and nothing is paid twice. Proven on the real PayPal sandbox (16 refunds).
- Approvals cover one exact, versioned payment list with a hash. Any change withdraws the approval.
- An audit trail where each entry carries the hash of the one before.
- PostgreSQL with versioned migrations, a job queue in the database, roles and permissions.
- 120 automated tests. CI on GitHub runs type checks and tests and passes.
- The AI only proposes, and its output is checked against the source.

---

## 11. The demo video

The video shows the current page. If the front end is rebuilt, the story stays the same but the screens change, so the video has to be recorded again. The flow, the narration and the PayPal sandbox proof can be reused.

---

## 12. Suggested order of work (no code yet)

1. Decide the front-end stack (section 1 fix) and the look (a short design pass first).
2. Clean the repository: move the first prototype out, set up a workspace (`apps/api`, `apps/web`, `packages/shared`), lint and format in CI.
3. Rebuild the front end as a real app: sign-up and sign-in, workspace, incidents list, the recall flow as proper pages, payments, audit, team, settings. Playwright tests in CI.
4. Security basics: password reset, email verification, security headers, CSRF token, pinned packages, row-level security.
5. Real email sending; deploy to Render with backups, error tracking and uptime checks.
6. PayPal: Transaction Search, webhooks on the public address, then one store connector (Shopify first).
7. Talk to shop owners; replace invented numbers with what they say.
8. Record the video again.
