# Submission video: plan and how to remake it

Output: `demo/video/make-good-submission.mp4`, 1920 x 1080, 2 min 52 s, with a neural voice-over. It shows the Next.js app with the ceramic mug set example (CM-412, batch K-0719). Video files are not in git; remake them with the commands at the end.

## The plan

| Time | Part | On screen | Point made |
|---|---|---|---|
| 0:00 | Title | Logo, one-line promise, four chips | What it is |
| 0:06 | The problem (animation) | A recall notice, 40 orders with question marks, records that disagree (CM412, CM-4120, no batch code, two payments), then "refund everyone" (money wasted) against "wait" (disputes pile up) | Why this is hard, and what it costs |
| 0:25 | Our approach (animation) | Two questions per buyer; orders sort into ready, held for a person, not affected; one approved list; PayPal refunds each once; disputes 0, paid twice 0 | The idea in one picture |
| 0:44 | Open the recall demo | Landing page with the 3D scene; the demo opens; the "simulator" and "synthetic" labels are highlighted | Honest labels |
| 0:53 | Finding your way | Left menu, the step tabs, Next step | How to navigate |
| 1:01 | Step 1 Notice | Read the notice; every line quotes it; save the rules | People decide |
| 1:10 | Step 2 Customers | A CSV file checked before import; the two-answer table; look-alike codes decided by a person | The core idea |
| 1:23 | Step 3 Evidence | A held customer's facts ("points the other way") | Why each customer stands where they do |
| 1:32 | Customer link | Email a one-time link; the customer's own page; they type the batch code | Asking the customer |
| 1:40 | Step 4 Options | Three refund policies, priced | Cost of each choice |
| 1:45 | Step 5 Approval | One exact list with a sha-256 fingerprint; approved | Approval covers one list |
| 1:53 | Step 6 Payments | A PayPal reply lost on purpose; unknown, then settled once (the wait is sped up 14 times, and the caption says so) | Never paid twice |
| 2:05 | Customers told | "You were paid" emails, only after PayPal confirms; audit chain intact | What happened, on the record |
| 2:12 | Around each recall | Claims form, Connections (PayPal, Shopify, WooCommerce, CSV), Team roles | The rest of the product |
| 2:21 | Built with | Eight tiles: PayPal REST APIs, Next.js + React, Node + Fastify, PostgreSQL with row-level security and encryption, Gemini, PayPal sandbox, 155 tests, Render | What it is built with |
| 2:32 | Credibility | Why you can trust it, and four ways to try it, including the live demo | How a judge can check and test it |
| 2:48 | Close | Logo, promise, live address, repository | |

The narration is in `demo/video-src/narration.json`. AI is off in this recording (Gemini was busy or at its limit); the voice-over says the notice is read "with Gemini or with built-in rules".

## How to remake it

From the repository root:

```bash
npm run build
```

```bash
python demo/video-src/make_voice.py
```

```bash
node demo/video-src/record.ts
```

- `make_voice.py` makes one clip per line with Microsoft's neural voice "Andrew" (edge-tts; only the narration text is sent). The recording used `RATE=+14%`.
- `record.ts` starts its own API on port 4000 (fresh data folder, PayPal simulator, AI off) and the built web app on 3200, so both ports must be free. It plays the animated scenes (`scenes.html`), drives the app in Edge with a cursor, highlights and captions, and joins the frames and voice with ffmpeg. Each step lasts at least as long as its voice clip.
- Needs Microsoft Edge, ffmpeg (`FFMPEG=` path or on PATH), Python with `edge-tts`, and internet for the voice. About 5 minutes.
