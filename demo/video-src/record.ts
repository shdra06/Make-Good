/// <reference lib="dom" />
// Records the submission video of the Next.js app:
//   animated problem and solution scenes, the real app driven in Microsoft Edge
//   with a visible cursor, highlights and captions, then built-with and
//   credibility scenes, all timed to the voice-over and joined into one MP4.
//
// From the repository root, after `npm run build`:
//   python demo/video-src/make_voice.py
//   node demo/video-src/record.ts
//
// Starts its own API on 4000 (fresh data folder, PayPal simulator, AI off) and
// the built web app on 3200; ports 4000 and 3200 must be free. Needs ffmpeg
// (FFMPEG=path or on PATH). Output: demo/video/make-good-submission.mp4.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Locator } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const OUT = path.join(REPO, "demo", "video");
const VOICE = path.join(OUT, "voice");
const FRAMES = path.join(OUT, "frames");
const API_PORT = 4000;
const WEB_PORT = 3200;
const BASE = `http://localhost:${WEB_PORT}`;
const W = 1920, H = 1080;
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

type Line = { id: string; scene?: string; caption: string | null; text: string };
const lines: Line[] = JSON.parse(fs.readFileSync(path.join(HERE, "narration.json"), "utf8"));
const durations: Record<string, number> = JSON.parse(fs.readFileSync(path.join(VOICE, "durations.json"), "utf8"));
const now = () => Date.now() / 1000;
const marks: Array<{ id: string; t: number }> = [];
const fastParts: Array<{ start: number; end: number; speed: number }> = [];

// Cursor, highlight and caption, drawn on top of the real app.
const OVERLAY = () => {
  if (location.protocol !== "http:") return;
  const make = () => {
    if (document.getElementById("v-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #v-cursor{position:fixed;left:0;top:0;z-index:2147483647;width:26px;height:26px;pointer-events:none;transition:transform .6s cubic-bezier(.3,.8,.3,1);transform:translate(760px,500px)}
      #v-cursor svg{width:26px;height:26px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.35))}
      .v-ripple{position:fixed;z-index:2147483646;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:4px solid #16a34a;pointer-events:none;animation:vr .6s ease-out forwards}
      @keyframes vr{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
      #v-hl{position:fixed;z-index:2147483645;border:3px solid #f59e0b;border-radius:12px;box-shadow:0 0 0 9999px rgba(8,24,18,.22);pointer-events:none;opacity:0;transition:all .45s ease}
      #v-cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483646;padding:11px 22px;border-radius:12px;background:rgba(6,40,28,.95);color:#fff;font:600 21px/1.3 "Segoe UI Variable Display","Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3);transition:opacity .35s;opacity:0;white-space:nowrap}`;
    document.head.append(style);
    const c = document.createElement("div");
    c.id = "v-cursor";
    c.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.6L9.6 21z" fill="#fff" stroke="#0d1b2e" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const hl = document.createElement("div"); hl.id = "v-hl";
    const cap = document.createElement("div"); cap.id = "v-cap";
    document.body.append(c, hl, cap);
    const w = window as unknown as Record<string, unknown>;
    w.__cursorTo = (x: number, y: number) => { c.style.transform = `translate(${x - 5}px,${y - 3}px)`; sessionStorage.setItem("v-cur", `${x},${y}`); };
    w.__ripple = (x: number, y: number) => { const r = document.createElement("div"); r.className = "v-ripple"; r.style.left = `${x}px`; r.style.top = `${y}px`; document.body.append(r); setTimeout(() => r.remove(), 700); };
    w.__hl = (r: { x: number; y: number; w: number; h: number } | null) => {
      if (!r) { hl.style.opacity = "0"; return; }
      Object.assign(hl.style, { left: `${r.x - 7}px`, top: `${r.y - 7}px`, width: `${r.w + 14}px`, height: `${r.h + 14}px`, opacity: "1" });
    };
    w.__cap = (t: string | null) => { if (t) cap.textContent = t; cap.style.opacity = t ? "1" : "0"; sessionStorage.setItem("v-cap", t ?? ""); };
    const saved = sessionStorage.getItem("v-cur");
    if (saved) { const [x, y] = saved.split(",").map(Number); c.style.transition = "none"; c.style.transform = `translate(${x! - 5}px,${y! - 3}px)`; requestAnimationFrame(() => (c.style.transition = "")); }
    const savedCap = sessionStorage.getItem("v-cap");
    if (savedCap) { cap.textContent = savedCap; cap.style.opacity = "1"; }
  };
  if (document.body) make(); else document.addEventListener("DOMContentLoaded", make);
};

function startServers(): ChildProcess[] {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "makegood-video-"));
  const api = spawn(process.execPath, ["apps/api/src/server.ts"], {
    cwd: REPO, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT: String(API_PORT), DATA_DIR: dataDir, NODE_ENV: "development", LOG_LEVEL: "warn", PUBLIC_URL: BASE, GEMINI_API_KEY: "", RATE_LIMIT_SCALE: "10" },
  });
  const web = spawn(`npx next start -p ${WEB_PORT}`, { cwd: path.join(REPO, "apps", "web"), shell: true, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, API_URL: `http://localhost:${API_PORT}` } });
  return [api, web];
}
function stopServers(children: ChildProcess[]) {
  for (const c of children) {
    if (c.pid === undefined || c.exitCode !== null) continue;
    try { execFileSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" }); } catch { c.kill(); }
  }
}
async function waitFor(url: string, seconds: number) {
  const until = now() + seconds;
  while (now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not start`);
}

async function main(): Promise<number> {
  const servers = startServers();
  process.on("exit", () => stopServers(servers));
  await waitFor(`http://localhost:${API_PORT}/api/health`, 60);
  await waitFor(`${BASE}/`, 90);
  console.log(`Recording ${BASE} (PayPal simulator, AI off)`);

  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  // 1536 x 864 at 125%: frames are 1920 x 1080 and the app's text is readable.
  const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25, colorScheme: "light", reducedMotion: "no-preference" });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // ---- frames from the browser, at most 30 a second ----
  const frames: Array<{ file: string; t: number }> = [];
  const writes: Array<Promise<void>> = [];
  const cdp = await context.newCDPSession(page);
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
  const scrollTo = async (loc: Locator, block: "start" | "center" = "center") => {
    await loc.first().evaluate((el, b) => el.scrollIntoView({ behavior: "smooth", block: b }), block).catch(() => undefined);
    await sleep(0.8);
  };
  const pointAt = async (loc: Locator) => {
    // The page redraws after each answer from the server, so an element can be replaced under us.
    let b: { x: number; y: number; width: number; height: number } | null = null;
    for (let i = 0; i < 6 && !b; i++) {
      b = await loc.first().scrollIntoViewIfNeeded({ timeout: 10_000 }).then(() => loc.first().boundingBox(), () => null).catch(() => null);
      if (!b) await sleep(0.4);
    }
    if (!b) throw new Error("nothing to point at");
    const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2;
    await page.evaluate(([px, py]) => (window as unknown as { __cursorTo: (a: number, b: number) => void }).__cursorTo(px!, py!), [x, y]);
    await sleep(0.5);
    return { x, y };
  };
  const click = async (loc: Locator) => {
    const { x, y } = await pointAt(loc);
    await page.evaluate(([px, py]) => (window as unknown as { __ripple: (a: number, b: number) => void }).__ripple(px!, py!), [x, y]);
    await loc.first().click();
    await sleep(0.3);
  };
  const btn = (name: string | RegExp) => page.getByRole("button", { name }).first();
  const tab = (name: string) => page.getByRole("navigation", { name: "Steps" }).getByRole("link", { name: new RegExp(name) });
  const record = (digits: string) => page.locator(`button[data-order*="${digits}"]`).first();

  // A segment starts its voice clip and lasts at least as long as the clip.
  async function segment(id: string, act: () => Promise<void>, tail = 0.3) {
    const l = line(id);
    const t0 = now();
    marks.push({ id, t: t0 });
    if (l.caption) await cap(l.caption);
    await act();
    const left = durations[id]! + tail - (now() - t0);
    if (left > 0) await sleep(left);
  }
  const scene = (id: string) => segment(id, async () => {
    await go(`${pathToFileURL(path.join(HERE, "scenes.html")).href}?scene=${line(id).scene}&dur=${durations[id]! + 0.3}`);
  }, 0.4);

  let ok = true;
  try {
    await go("about:blank");
    await scene("title");
    await scene("problem");
    await scene("solution");

    // ---- the app ----
    await go(`${BASE}/`);
    await page.getByRole("button", { name: "Open the recall demo" }).first().waitFor();
    await sleep(0.5);
    let incidentUrl = "";
    await segment("w_open", async () => {
      await sleep(1.0);
      await click(btn("Open the recall demo"));
      await page.waitForURL(/\/notice$/, { timeout: 60_000 });
      incidentUrl = page.url().replace(/\/notice$/, "");
      await sleep(0.4);
      await hl(page.getByText("PayPal: simulator, no real money").first());
      await sleep(1.2);
      await hl(page.getByText("Records: synthetic (invented)").first());
    });
    await segment("w_nav", async () => {
      await hl(page.getByRole("link", { name: "Dashboard" }).locator("xpath=ancestor::nav[1]"));
      await pointAt(page.getByRole("link", { name: "Monitoring" }));
      await sleep(1.4);
      await hl(page.getByRole("navigation", { name: "Steps" }));
      await pointAt(tab("Customers"));
      await sleep(1.4);
      await hl(null);
    });
    await segment("w_notice", async () => {
      await click(btn(/^Read it/));
      const said = page.getByTestId("notice-reading");
      await said.waitFor({ timeout: 60_000 });
      await scrollTo(said, "start");
      await hl(said);
      await sleep(2.5);
      await hl(null);
      await click(btn("Save these rules"));
      await page.getByRole("heading", { name: /Rules in force, version 1/ }).waitFor();
    });
    await segment("w_match", async () => {
      await click(tab("Customers"));
      const upload = page.getByTestId("csv-upload");
      await click(upload.locator("summary"));
      await page.getByLabel("Order file").setInputFiles(path.join(REPO, "demo", "sample-orders.csv"));
      const checked = page.getByTestId("csv-result");
      await checked.filter({ hasText: "3 rows, 2 orders" }).waitFor({ timeout: 30_000 });
      await hl(checked);
      await sleep(1.0);
      await hl(null);
      await upload.locator("summary").click();
      await click(btn("Find affected customers"));
      const matrix = page.getByTestId("matrix");
      await matrix.waitFor({ timeout: 60_000 });
      await scrollTo(matrix);
      await hl(matrix);
      await sleep(1.8);
      await hl(null);
      const aliases = page.getByTestId("aliases");
      await scrollTo(aliases);
      // Two decisions on screen: the look-alike dinner set is a different product, the code without a hyphen is the same.
      for (const [alias, answer] of [["CM-4120", "Different"], ["CM412", "Same product"]] as const) {
        const row = aliases.locator(`tr[data-alias="${alias}"]`);
        if ((await row.getByRole("button", { name: answer }).count()) === 0) continue;
        await click(row.getByRole("button", { name: answer }));
        await row.getByRole("button").first().waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
      }
    });
    await segment("w_map", async () => {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
      await sleep(0.6);
      await click(tab("Evidence"));
      await sleep(0.8);
      await click(record("5019"));
      const sheet = page.getByRole("dialog");
      await sheet.waitFor();
      await sleep(0.6);
      await hl(sheet.getByText("points the other way").first());
      await sleep(2.5);
      await hl(null);
    });
    await segment("w_link", async () => {
      await page.keyboard.press("Escape");
      await sheetGone();
      await click(record("5020"));
      await click(page.getByRole("dialog").getByRole("button", { name: "Email the customer a link" }));
      await page.getByRole("dialog").getByText("Saved in the outbox as a file").waitFor({ timeout: 30_000 });
      const link = await page.getByRole("dialog").getByLabel(/Send this link to the customer/).inputValue();
      await sleep(0.8);
      await go(link);
      await page.getByRole("heading", { name: "One question about your order" }).waitFor();
      await cap("What the customer sees: one question, nothing else");
      const input = page.getByLabel("Batch code");
      await click(input);
      await input.pressSequentially("K-0719", { delay: 60 });
      await click(btn("Send"));
      await page.getByRole("heading", { name: "Thank you" }).waitFor();
      await sleep(0.4);
    });
    await go(`${incidentUrl}/options`);
    await page.getByTestId("policies").waitFor({ timeout: 60_000 });
    await segment("w_options", async () => {
      const pol = page.getByTestId("policies");
      await scrollTo(pol);
      await hl(pol);
      await sleep(3);
      await hl(null);
    });
    await segment("w_approve", async () => {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
      await click(tab("Approval"));
      await click(btn("Build the payment list"));
      const hash = page.getByTestId("manifest-hash");
      await hash.waitFor();
      await hl(hash);
      await sleep(0.8);
      await hl(null);
      await click(btn("Send for approval"));
      await click(btn(/Approve exactly this list/));
      await page.getByText("Approved. The approval covers this version").waitFor();
    });
    await segment("w_pay", async () => {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
      await click(tab("Payments"));
      await click(btn("Lose one reply from PayPal"));
      await click(btn("Start paying"));
      const ops = page.getByTestId("operations");
      await ops.waitFor();
      const unknown = page.getByText("Outcome unknown: asking PayPal").first();
      await unknown.waitFor({ timeout: 60_000 });
      await scrollTo(unknown);
      await hl(unknown);
      await sleep(1.5);
      await hl(null);
      const t = now();
      await cap("Asking PayPal again with the same request ID (sped up)");
      await page.getByText("Differences found and how they were settled").waitFor({ timeout: 240_000 });
      await page.waitForFunction(() => !(document.querySelector('[data-testid="operations"]')?.textContent ?? "").includes("Outcome unknown"), null, { timeout: 240_000 });
      fastParts.push({ start: t + 0.5, end: now() - 0.5, speed: 14 });
      await cap(line("w_pay").caption);
      const lost = page.getByText("The first reply was lost").first();
      await scrollTo(lost);
      await hl(lost);
      await sleep(1.6);
      await hl(null);
    });
    await segment("w_results", async () => {
      await click(btn("Email the customers PayPal has paid"));
      const notices = page.getByTestId("notices");
      await notices.filter({ hasText: "[TEST: PayPal simulator, no real money]" }).waitFor({ timeout: 30_000 });
      await scrollTo(notices);
      await hl(notices);
      await sleep(1.2);
      await hl(null);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
      await click(tab("Activity"));
      const chain = page.getByText(/entries, chain intact/).first();
      await chain.waitFor({ timeout: 30_000 });
      await hl(chain);
      await sleep(0.8);
    });
    await segment("w_more", async () => {
      await click(tab("Claims"));
      await click(btn("Open the claim form"));
      const url = page.getByTestId("claim-url");
      await url.waitFor({ timeout: 30_000 });
      await hl(url);
      await sleep(1.0);
      await click(page.getByRole("link", { name: "Connections" }));
      const stores = page.getByText("Stores and orders").first();
      await stores.waitFor({ timeout: 30_000 });
      await scrollTo(stores);
      await hl(stores.locator("xpath=ancestor::*[self::section or contains(@class,'rounded')][1]"));
      await sleep(1.1);
      await click(page.getByRole("link", { name: "Team" }));
      const roles = page.getByText("What each role may do").first();
      await roles.waitFor({ timeout: 30_000 });
      await scrollTo(roles);
      await hl(roles.locator("xpath=ancestor::*[self::section or contains(@class,'rounded')][1]"));
      await sleep(1.1);
      await hl(null);
    });
    await cap(null);
    await scene("stack");
    await scene("trust");
    await scene("close");
    await sleep(0.4);
  } catch (err) {
    ok = false;
    console.log("FAILED:", err instanceof Error ? err.message.split("\n")[0] : err);
    await page.screenshot({ path: path.join(OUT, "failure.png") }).catch(() => undefined);
  }

  async function sheetGone() {
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);
    await sleep(0.3);
  }

  const end = now();
  await cdp.send("Page.stopScreencast").catch(() => undefined);
  await context.close();
  await browser.close();
  stopServers(servers);
  await Promise.all(writes);
  if (errors.length) console.log("page errors:", errors.join("; "));
  if (!ok) return 1;

  // ---- join frames and voice; the long wait for PayPal runs 14 times faster ----
  const t0 = frames[0]!.t;
  const v = (t: number) => {
    let x = t - t0;
    for (const f of fastParts) x -= Math.max(0, Math.min(t, f.end) - f.start) * (1 - 1 / f.speed);
    return x;
  };
  const list: string[] = [];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1]!.t : end;
    list.push(`file '${f.file.replace(/\\/g, "/")}'`, `duration ${Math.max(0.001, v(next) - v(f.t)).toFixed(4)}`);
  });
  list.push(`file '${frames.at(-1)!.file.replace(/\\/g, "/")}'`);
  const listFile = path.join(FRAMES, "list.txt");
  fs.writeFileSync(listFile, list.join("\n"));

  const inputs: string[] = ["-f", "concat", "-safe", "0", "-i", listFile];
  const filters: string[] = [];
  marks.forEach((m, i) => {
    inputs.push("-i", path.join(VOICE, `${m.id}.mp3`));
    const ms = Math.round((v(m.t) + 0.2) * 1000);
    filters.push(`[${i + 1}:a]adelay=${ms}|${ms}[a${i}]`);
  });
  filters.push(`${marks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${marks.length}:normalize=0:dropout_transition=0[aout]`);
  const mp4 = path.join(OUT, "make-good-submission.mp4");
  execFileSync(FFMPEG, [
    "-y", "-loglevel", "error", ...inputs, "-filter_complex", filters.join(";"),
    "-map", "0:v", "-map", "[aout]", "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", mp4,
  ], { stdio: "inherit" });
  fs.writeFileSync(path.join(OUT, "marks.json"), JSON.stringify(marks.map((m) => ({ id: m.id, at: Number(v(m.t).toFixed(2)) })), null, 1));
  fs.rmSync(FRAMES, { recursive: true, force: true });
  console.log(`Video: ${mp4} (${v(end).toFixed(1)} s)`);
  return 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
