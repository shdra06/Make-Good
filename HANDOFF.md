# Make Good: hand-off

Read this first. It is the shortest path to working on the project. Update the "Work queue" and "Last session" sections at the end of every session.

## What it is

A PayPal hackathon project. When a supplier recalls one batch of a product, Make Good works out who is owed money, why, how much, and what was actually paid. Flagship story: batch B-2217 of the HM-300 hand mixer.

## Where things are

| Path | What |
|---|---|
| `apps/api/` | The platform backend. Fastify, TypeScript run directly by Node 24 (no build), PostgreSQL via PGlite locally. Port 4000. |
| `apps/web/public/` | The page: `index.html`, `app.js`, `styles.css`. Plain JS, no build. Served by the API. App shell: navy sidebar with the steps (`sidebar()`, `nextStep()`), case header with key numbers (`caseHead()`), a floating "Next step" button. Do not reuse the class name `side` (the matrix uses it). |
| `apps/api/db/migrations/` | `0001` to `0004`. Applied files are never edited; add `0005_…`. |
| `docs/CHECKLIST.md` | Status of everything, with evidence. Change it only after something ran and passed. |
| `docs/` others | `STRATEGY.md`, `DEMO.md`, `ARCHITECTURE.md`, `PAYPAL.md`, `VERIFICATION.md` |
| `src/`, `public/` (repo root) | The first prototype. Leave it alone. |

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

## Commands (run in `apps/api`)

| Command | Use |
|---|---|
| `npm test` | 120 tests, about 2 minutes. Must pass before every commit. |
| `npx tsc --noEmit` | Type check |
| `npm start` | Server and page at http://localhost:4000. "Open the recall case" loads the demo. |
| `npm run sandbox:recall` | The recall case on the real PayPal sandbox. About 8 minutes: run it in the background. |
| `npm run ai:verify` | The three AI steps against the real model in `.env`. About 1 minute. |
| `npm run test:e2e` | The page in Edge, start to finish, on the simulator. About 1 minute. |
| `npm run demo:capture` | Same walk-through, slow, with captions: writes the demo video and screenshots. About 5 minutes. |

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
- [ ] Trim or voice the demo video (`docs/DEMO.md`); re-run `npm run demo:capture` first, the page changed

Known loose end: another session's `integration/proposed-0002_…sql` (outside this repo) must become `0003` if it is ever applied.

## Last session

11 Nov 2026 (seventh sitting, Opus): new look for the presentation: PayPal-blue app shell with a step sidebar, key numbers, Next-step button, new landing and customer page. Browser test passes; screenshots re-made without AI (Gemini key at its daily limit). Claude removed earlier the same day. Next: when Gemini works again, run `npm run ai:verify`, then `npm run demo:capture` for the final video.
