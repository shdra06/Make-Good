/// <reference lib="dom" />
// Records the submission video: animated problem and solution scenes, then
// the real page driven in Microsoft Edge with a visible cursor, timed to the
// voice-over, then joined into one MP4.
//
//   python ../../demo/video-src/make_voice.py     (voice clips first)
//   node scripts/demo-video.ts [--ai]
//
// The app runs on its own in-memory database and the PayPal simulator, as in
// demo-capture.ts. Frames come from the browser's screencast, so text stays
// sharp. Output: make-good/demo/video/make-good-submission.mp4 (not in git).

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Locator, type Page } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SRC = path.join(REPO, "demo", "video-src");
const OUT = path.join(REPO, "demo", "video");
const VOICE = path.join(OUT, "voice");
const FRAMES = path.join(OUT, "frames");
const PORT = 4200;
const BASE = `http://localhost:${PORT}`;
const W = 1920, H = 1080;
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const useAi = process.argv.includes("--ai");

type Line = { id: string; scene?: string; caption: string | null; text: string };
const lines: Line[] = JSON.parse(fs.readFileSync(path.join(SRC, "narration.json"), "utf8"));
const durations: Record<string, number> = JSON.parse(fs.readFileSync(path.join(VOICE, "durations.json"), "utf8"));
const now = () => Date.now() / 1000;

const marks: Array<{ id: string; t: number }> = [];
const fastParts: Array<{ start: number; end: number; speed: number }> = [];

// Cursor, highlight and caption, drawn on top of the real page.
const OVERLAY = () => {
  if (location.protocol !== "http:") return;
  const make = () => {
    if (document.getElementById("v-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #v-cursor{position:fixed;left:0;top:0;z-index:2147483647;width:30px;height:30px;pointer-events:none;transition:transform .65s cubic-bezier(.3,.8,.3,1);transform:translate(960px,600px)}
      #v-cursor svg{width:30px;height:30px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.35))}
      .v-ripple{position:fixed;z-index:2147483646;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;border:4px solid #0070e0;pointer-events:none;animation:vr .6s ease-out forwards}
      @keyframes vr{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
      #v-hl{position:fixed;z-index:2147483645;border:4px solid #ffb020;border-radius:14px;box-shadow:0 0 0 9999px rgba(8,18,36,.28);pointer-events:none;opacity:0;transition:all .45s ease}
      .toast{top:18px!important;bottom:auto!important}
      #v-cap{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:2147483646;padding:14px 26px;border-radius:14px;background:rgba(0,32,91,.94);color:#fff;font:600 26px/1.3 "Segoe UI Variable Display","Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3);transition:opacity .35s;opacity:0;white-space:nowrap}`;
    document.head.append(style);
    const c = document.createElement("div");
    c.id = "v-cursor";
    c.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.6L9.6 21z" fill="#fff" stroke="#0d1b2e" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const hl = document.createElement("div"); hl.id = "v-hl";
    const cap = document.createElement("div"); cap.id = "v-cap";
    document.body.append(c, hl, cap);
    const w = window as unknown as Record<string, unknown>;
    w.__cursorTo = (x: number, y: number) => { c.style.transform = `translate(${x - 6}px,${y - 3}px)`; sessionStorage.setItem("v-cur", `${x},${y}`); };
    w.__ripple = (x: number, y: number) => { const r = document.createElement("div"); r.className = "v-ripple"; r.style.left = `${x}px`; r.style.top = `${y}px`; document.body.append(r); setTimeout(() => r.remove(), 700); };
    w.__hl = (r: { x: number; y: number; w: number; h: number } | null) => {
      if (!r) { hl.style.opacity = "0"; return; }
      Object.assign(hl.style, { left: `${r.x - 8}px`, top: `${r.y - 8}px`, width: `${r.w + 16}px`, height: `${r.h + 16}px`, opacity: "1" });
    };
    w.__cap = (t: string | null) => { if (t) cap.textContent = t; cap.style.opacity = t ? "1" : "0"; };
    const saved = sessionStorage.getItem("v-cur");
    if (saved) { const [x, y] = saved.split(",").map(Number); c.style.transition = "none"; c.style.transform = `translate(${x! - 6}px,${y! - 3}px)`; requestAnimationFrame(() => (c.style.transition = "")); }
  };
  if (document.body) make(); else document.addEventListener("DOMContentLoaded", make);
};

async function main(): Promise<number> {
  if (!EDGE) { console.log("Microsoft Edge was not found."); return 1; }
  // The app runs in its own process, so recording is not slowed by its work.
  const server = spawn(process.execPath, [path.join(HERE, "demo-video-server.ts"), String(PORT), ...(useAi ? ["--ai"] : [])], { stdio: ["ignore", "pipe", "inherit"] });
  const ai = await new Promise<string>((resolve, reject) => {
    server.stdout!.on("data", (d: Buffer) => { const m = /READY (\S+)/.exec(String(d)); if (m) resolve(m[1]!); });
    server.on("exit", (code) => reject(new Error(`server exited (${code})`)));
  });
  console.log(`Recording on ${BASE} (PayPal simulator; AI: ${ai})`);

  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  // 1536 x 864 at 125%: frames are 1920 x 1080, and the app's text is large enough to read in the video.
  const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25, colorScheme: "light" });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // ---- frames from the browser ----
  const frames: Array<{ file: string; t: number }> = [];
  const cdp = await context.newCDPSession(page);
  // Reply to the browser first, keep at most 30 frames a second, write in the background.
  const writes: Array<Promise<void>> = [];
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
    const t = f.metadata.timestamp ?? now();
    if (frames.length > 0 && t - frames.at(-1)!.t < 1 / 31) return;
    const file = path.join(FRAMES, `${String(frames.length).padStart(6, "0")}.jpg`);
    frames.push({ file, t });
    writes.push(fs.promises.writeFile(file, Buffer.from(f.data, "base64")));
  });
  const startCast = () => cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 }).catch(() => undefined);

  // ---- helpers ----
  const sleep = (s: number) => page.waitForTimeout(Math.max(0, s * 1000));
  const line = (id: string) => lines.find((l) => l.id === id)!;
  const go = async (url: string) => { await page.goto(url); await startCast(); };
  const cap = (t: string | null) => page.evaluate((x) => (window as unknown as { __cap?: (s: string | null) => void }).__cap?.(x), t);
  const hl = async (target: Locator | null) => {
    const r = target ? await target.first().boundingBox({ timeout: 3000 }).catch(() => null) : null;
    await page.evaluate((b) => (window as unknown as { __hl?: (x: unknown) => void }).__hl?.(b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null), r);
  };
  const scrollTo = async (sel: string | Locator, offset = 110) => {
    const loc = typeof sel === "string" ? page.locator(sel).first() : sel;
    await loc.evaluate((el, off) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: "smooth" }), offset);
    await sleep(1.1);
  };
  const pointAt = async (loc: Locator) => {
    // The page redraws after each answer from the server, so the element can be replaced under us.
    let b: { x: number; y: number; width: number; height: number } | null = null;
    for (let i = 0; i < 5 && !b; i++) {
      b = await loc.scrollIntoViewIfNeeded({ timeout: 10_000 }).then(() => loc.boundingBox(), () => null).catch(() => null);
      if (!b) await sleep(0.4);
    }
    if (!b) throw new Error("could not find an element to point at");
    const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2;
    await page.evaluate(([px, py]) => (window as unknown as { __cursorTo: (a: number, b: number) => void }).__cursorTo(px!, py!), [x, y]);
    await sleep(0.75);
    return { x, y };
  };
  const click = async (loc: Locator) => {
    const { x, y } = await pointAt(loc);
    await page.evaluate(([px, py]) => (window as unknown as { __ripple: (a: number, b: number) => void }).__ripple(px!, py!), [x, y]);
    await loc.click();
    await sleep(0.35);
  };
  const btn = (name: string | RegExp) => page.getByRole("button", { name }).first();

  // A segment starts its voice clip and lasts at least as long as the clip.
  async function segment(id: string, act: () => Promise<void>, tail = 0.5) {
    const l = line(id);
    const t0 = now();
    marks.push({ id, t: t0 });
    if (l.caption) await cap(l.caption);
    await act();
    const left = durations[id]! + tail - (now() - t0);
    if (left > 0) await sleep(left);
  }
  const scene = (id: string) => segment(id, async () => {
    await go(`${pathToFileURL(path.join(SRC, "scenes.html")).href}?scene=${line(id).scene}&dur=${durations[id]! + 0.4}`);
  }, 1.0);

  let ok = true;
  try {
    await go("about:blank");
    await scene("title");
    await scene("problem");
    await scene("solution");
    await scene("stack");

    // ---- the page ----
    await go(`${BASE}/`);
    await page.getByText("Who is owed money").waitFor();
    await sleep(0.6);
    await segment("w_open", async () => {
      await sleep(2.5);
      await click(btn("Open the recall case"));
      await page.locator("#s1").waitFor({ timeout: 60_000 });
      await sleep(1);
      await hl(page.locator(".sidebar .labels"));
    });
    await segment("w_nav", async () => {
      await hl(page.locator(".sidebar .steps"));
      await pointAt(page.locator(".sidebar .step").nth(0));
      await sleep(1.5);
      await hl(page.locator(".casehead .kpi-row"));
      await sleep(1.8);
      await hl(page.locator("a.next"));
      await pointAt(page.locator("a.next"));
      await sleep(1.5);
      await hl(null);
    });
    await segment("w_notice", async () => {
      await click(btn(/^Read it/));
      await page.getByText("What the notice says").waitFor({ timeout: 120_000 });
      await sleep(0.8);
      await hl(page.locator("#s1 .card").nth(0));
      await sleep(4);
      await hl(null);
      await click(btn("Save these rules"));
      await page.getByText("Rules in force, version 1").waitFor();
    });
    await segment("w_match", async () => {
      await click(btn("Find affected customers"));
      await page.locator("#s2 .matrix").waitFor({ timeout: 60_000 });
      await scrollTo("#s2 .matrix", 200);
      await hl(page.locator("#s2 .matrix"));
      await pointAt(page.locator("#s2 .cell.ready").first());
      await sleep(2.5);
      await hl(null);
      await scrollTo("#s2 table", 160);
      const decide = async (alias: string, label: string) => {
        const row = page.locator("#s2 tbody tr").filter({ has: page.locator("td:first-child b", { hasText: new RegExp(`^${alias}$`) }) });
        await click(row.getByRole("button", { name: label }));
        await row.getByText(label === "Same product" ? "same product:" : "different:").waitFor({ timeout: 30_000 });
      };
      await decide("HM300", "Same product");
      await decide("Kestrel hand mixer HM-300 white", "Same product");
      await decide("HM-3000", "Different");
    });
    await segment("w_map", async () => {
      await scrollTo("#s3");
      await sleep(1.5);
      await click(page.locator("#s3 .row").filter({ hasText: "#5019" }).first());
      await page.locator(".drawer").waitFor();
      await sleep(1);
      await hl(page.getByText("points the other way").first());
      await sleep(3);
      await hl(null);
    });
    await segment("w_link", async () => {
      await click(page.locator(".drawer .close, .drawer button:has-text('Close')").first());
      await page.locator(".drawer").waitFor({ state: "detached" });
      await click(page.locator("#s3 .row").filter({ hasText: "#5020" }).first());
      await click(btn("Email the customer a link"));
      await page.locator(".drawer").getByText("Saved in the outbox").waitFor({ timeout: 30_000 });
      const link = await page.locator(".drawer input[readonly]").inputValue();
      await sleep(1);
      await go(link);
      await page.getByText("One question about your order").waitFor();
      await cap("What the customer sees: one question, nothing else");
      const input = page.locator("input").first();
      await click(input);
      await input.pressSequentially("B-2224", { delay: 120 });
      await click(btn("Send"));
      await page.getByText("Thank you").waitFor();
      await sleep(1.2);
    });
    await go(`${BASE}/`);
    await page.locator("#s4").waitFor({ timeout: 60_000 });
    await segment("w_options", async () => {
      await scrollTo("#s4");
      await hl(page.locator("#s4 .grid3").first());
      await sleep(4);
      await hl(null);
    });
    await segment("w_approve", async () => {
      await click(btn("Build the payment list"));
      await page.getByText("Payment list, version 1").waitFor();
      await scrollTo("#s6");
      await click(btn("Send for approval"));
      await btn(/^Approve exactly this list/).waitFor();
      await hl(page.locator("#s6 .hash").first());
      await sleep(1.5);
      await hl(null);
      await click(btn(/^Approve exactly this list/));
      await btn("Start paying").waitFor();
    });
    await segment("w_pay", async () => {
      await scrollTo("#s7");
      await click(btn("Lose one reply from PayPal"));
      await click(btn("Start paying"));
      await page.getByText("Each payment, as PayPal reports it").waitFor();
      await scrollTo("#s7");
      await page.getByText("Outcome unknown: asking PayPal").first().waitFor({ timeout: 60_000 });
      await hl(page.getByText("Outcome unknown: asking PayPal").first());
      await sleep(2);
      await hl(null);
      const t = now();
      await cap("Asking PayPal again with the same request ID (sped up)");
      await page.waitForFunction(() => {
        const s = document.querySelector("#s7")?.textContent ?? "";
        return s.includes("Differences found") && !s.includes("Outcome unknown");
      }, null, { timeout: 240_000 });
      fastParts.push({ start: t + 0.5, end: now() - 0.5, speed: 8 });
      await cap(line("w_pay").caption);
      await scrollTo("#s7");
      await hl(page.getByText("The first reply was lost").first());
      await sleep(2.5);
      await hl(null);
    });
    await segment("w_results", async () => {
      await click(btn("Email the customers PayPal has paid"));
      await page.locator("#s7").filter({ hasText: "[TEST: PayPal simulator, no real money]" }).waitFor({ timeout: 30_000 });
      await page.locator("#s7 .notices details").first().click();
      await scrollTo("#s7 .notices");
      await sleep(2.5);
      await scrollTo("#s7 .kpis");
      await sleep(2.5);
      await scrollTo("#s7 .audit");
      await hl(page.locator("#s7 .audit"));
      await sleep(2);
    });
    await cap(null);
    await scene("trust");
    await scene("close");
    await sleep(0.5);
  } catch (err) {
    ok = false;
    console.log("FAILED:", err instanceof Error ? err.message.split("\n")[0] : err);
    await page.screenshot({ path: path.join(OUT, "failure.png") }).catch(() => undefined);
  }
  const end = now();
  await cdp.send("Page.stopScreencast").catch(() => undefined);
  await context.close();
  await browser.close();
  server.kill();
  await Promise.all(writes);
  if (errors.length) console.log("page errors:", errors.join("; "));
  if (!ok) return 1;

  // ---- join frames and voice ----
  // Time on the video = real time, with the long wait for PayPal sped up.
  const t0 = frames[0]!.t;
  const v = (t: number) => {
    let x = t - t0;
    for (const f of fastParts) {
      const overlap = Math.max(0, Math.min(t, f.end) - f.start);
      x -= overlap * (1 - 1 / f.speed);
    }
    return x;
  };
  const list: string[] = [];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1]!.t : end;
    const d = Math.max(0.001, v(next) - v(f.t));
    list.push(`file '${f.file.replace(/\\/g, "/")}'`, `duration ${d.toFixed(4)}`);
  });
  list.push(`file '${frames.at(-1)!.file.replace(/\\/g, "/")}'`);
  const listFile = path.join(FRAMES, "list.txt");
  fs.writeFileSync(listFile, list.join("\n"));

  const inputs: string[] = ["-f", "concat", "-safe", "0", "-i", listFile];
  const filters: string[] = [];
  marks.forEach((m, i) => {
    inputs.push("-i", path.join(VOICE, `${m.id}.mp3`));
    const ms = Math.round((v(m.t) + 0.25) * 1000);
    filters.push(`[${i + 1}:a]adelay=${ms}|${ms}[a${i}]`);
  });
  filters.push(`${marks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${marks.length}:normalize=0:dropout_transition=0,volume=1.0[aout]`);
  const mp4 = path.join(OUT, "make-good-submission.mp4");
  execFileSync(FFMPEG, [
    "-y", "-loglevel", "error", ...inputs, "-filter_complex", filters.join(";"),
    "-map", "0:v", "-map", "[aout]", "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", mp4,
  ], { stdio: "inherit" });
  console.log(`Video: ${mp4} (${v(end).toFixed(1)} s, ${frames.length} frames)`);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, "marks.json"), JSON.stringify(marks.map((m) => ({ id: m.id, at: Number(v(m.t).toFixed(2)) })), null, 1));
  return 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
