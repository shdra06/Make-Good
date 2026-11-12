# Submission video: plan and how to remake it

Output: `demo/video/make-good-submission.mp4`, 1920 x 1080, about 3 min 47 s, with a neural voice-over. Video files are not in git; remake them with the commands at the end.

## The plan

| Time | Part | On screen | Point made |
|---|---|---|---|
| 0:00 | Title | Logo, one-line promise, four chips | What it is |
| 0:07 | The problem (animation) | A recall notice, 40 orders with question marks, records that disagree (HM300, HM-3000, no batch code, two payments), then "refund everyone" ($ wasted) against "wait" (disputes pile up) | Why this is hard, and what it costs |
| 0:35 | Our approach (animation) | Two questions per buyer; orders sort into ready, held for a person, not affected; one approved list; PayPal refunds each once; disputes 0, paid twice 0 | The idea in one picture |
| 1:02 | Built with | Eight tiles: PayPal REST APIs, PayPal sandbox, Node 24 + TypeScript, PostgreSQL, Gemini, plain HTML/CSS/JS, 120 tests, Playwright | What it is built with |
| 1:22 | The app, step by step | Real page in Edge with a visible cursor, a highlight on what is being explained, and a caption per step | How to navigate, and what each feature does |
| 1:22 | | Open the recall case; simulator labels | Honest labels |
| 1:32 | | Sidebar: done, do this now, Next step button; the key numbers | Where you are, what to do next |
| 1:40 | | Step 1: read the notice, quotes, save the rules | People decide |
| 1:55 | | Step 2: the two-answer table; look-alike codes decided by a person | The core idea |
| 2:10 | | Step 3: Recovery Map, a held record's evidence | Why each customer stands where they do |
| 2:22 | | Email the customer a link; the customer's own page | Asking the customer |
| 2:32 | | Step 4: three policies priced | Cost of each choice |
| 2:40 | | Step 5: one exact list, version and fingerprint, approved | Approval covers one list |
| 2:50 | | Step 6: pay; a PayPal reply is lost on purpose; unknown, then settled once (the wait is sped up and says so) | Never paid twice |
| 3:06 | | Customer emails, results against known answers, audit trail | What happened, on the record |
| 3:19 | Credibility | Why you can trust it (labels, sandbox, tests, browser test) and Try it yourself (CSV, customer link, lose a reply, your sandbox) | How a judge can check and test it |
| 3:41 | Close | Logo, promise, repository | |

The narration is in `demo/video-src/narration.json`. The AI steps are off in this recording (the Gemini key was at its daily limit); the voice-over says that the built-in rules read the notice and that Gemini does it when a key is set.

## How it is made

1. `python demo/video-src/make_voice.py` makes one voice clip per line with Microsoft's neural voice "Andrew" (edge-tts; only the narration text is sent) and measures each.
2. (Removed on branch `production-grade`; still on `main`.) `node scripts/demo-video.ts` (in `apps/api`) starts the app in its own process (in-memory database, PayPal simulator), plays the animated scenes (`demo/video-src/scenes.html`), then drives the real page in Edge. Each step lasts at least as long as its voice clip. Frames come straight from the browser at up to 30 a second.
3. The same script joins the frames and voice clips with ffmpeg. The long wait for PayPal is sped up eight times, and the caption says so.

```bash
cd apps/api && python ../../demo/video-src/make_voice.py && npm run demo:video
```

Needs Microsoft Edge, ffmpeg on the PATH (or `FFMPEG=` set), Python with `edge-tts`, and internet for the voice. Add `-- --ai` to the second command to show Gemini in the recording once the key works.
