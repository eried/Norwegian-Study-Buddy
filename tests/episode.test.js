#!/usr/bin/env node
// Headless Chromium tests for the episode player (Tesla UI).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

function loadPuppeteer() {
  const candidates = [
    path.join(__dirname, "node_modules", "puppeteer-core"),
    path.join(__dirname, "..", "node_modules", "puppeteer-core"),
    "puppeteer-core",
    "/workspace/nsb-test/node_modules/puppeteer-core",
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* try next */ }
  }
  throw new Error("Install puppeteer-core (cd tests && npm install)");
}

const puppeteer = loadPuppeteer();
const ROOT = path.join(__dirname, "..");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const SLUG = "hvordan-unnga-tankekjor";
const WORKER = "https://norwegian-study-buddy-notes.erwin-ce6.workers.dev";
const PASS = process.env.NSB_PASSPHRASE || "123";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath === "/") urlPath = "/index.html";
      const file = path.normalize(path.join(ROOT, urlPath));
      if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.statusCode = 404; return res.end("not found"); }
        res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchNotes() {
  const res = await fetch(WORKER + "/notes/" + encodeURIComponent(SLUG), { cache: "no-store" });
  if (!res.ok) throw new Error("GET notes HTTP " + res.status);
  const data = await res.json();
  return Array.isArray(data.notes) ? data.notes : [];
}

async function deleteNote(id) {
  const res = await fetch(WORKER + "/notes/" + encodeURIComponent(SLUG), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Passphrase": PASS },
    body: JSON.stringify({ action: "delete", id }),
  });
  return res.ok;
}

const INSTALL_STUBS = () => {
  window.__ttsLog = [];
  window.__mediaLog = [];
  function Utterance(text) {
    this.text = text;
    this.lang = "";
    this.voice = null;
    this.rate = 1;
    this.onend = null;
    this.onerror = null;
  }
  const synth = {
    speaking: false, pending: false, paused: false,
    cancel() { this.speaking = false; window.__ttsLog.push({ typ: "cancel" }); },
    getVoices() { return [{ lang: "es-ES", name: "Test ES", voiceURI: "test-es" }]; },
    addEventListener() {},
    removeEventListener() {},
    speak(u) {
      window.__ttsLog.push({ typ: "speak", text: u.text, lang: u.lang });
      this.speaking = true;
      setTimeout(() => {
        this.speaking = false;
        if (typeof u.onend === "function") u.onend();
      }, 40);
    },
  };
  Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, writable: true, value: Utterance });
  Object.defineProperty(window, "speechSynthesis", { configurable: true, writable: true, value: synth });
  const proto = window.HTMLMediaElement.prototype;
  const pausedMap = new WeakMap();
  Object.defineProperty(proto, "paused", {
    configurable: true,
    get() { return pausedMap.has(this) ? pausedMap.get(this) : true; },
  });
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get() { return this.__ct || 0; },
    set(v) { this.__ct = Number(v) || 0; },
  });
  Object.defineProperty(proto, "duration", {
    configurable: true,
    get() { return this.__dur || 1296; },
  });
  proto.play = function () {
    pausedMap.set(this, false);
    window.__mediaLog.push({ typ: "play", t: this.currentTime, id: this.id || "", src: this.getAttribute("src") || this.src || "" });
    this.dispatchEvent(new Event("play"));
    const src = this.getAttribute("src") || this.src || "";
    if (this.id === "es-audio" || /\/es\/\d+\.mp3/.test(src)) {
      setTimeout(() => {
        pausedMap.set(this, true);
        window.__mediaLog.push({ typ: "ended", id: this.id || "es-audio", src });
        this.dispatchEvent(new Event("ended"));
      }, 40);
    }
    return Promise.resolve();
  };
  proto.pause = function () {
    pausedMap.set(this, true);
    window.__mediaLog.push({ typ: "pause", t: this.currentTime, id: this.id || "" });
    this.dispatchEvent(new Event("pause"));
  };
};

async function stubNotesApi(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("norwegian-study-buddy-notes") || /\/notes\/[^/]+\.json(\?|$)/.test(url)) {
      return req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ slug: SLUG, notes: [] }),
      });
    }
    return req.continue();
  });
}

async function openEpisode(browser, base, { passphrase, hideTop, extras, liveNotes } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1180, height: 700, deviceScaleFactor: 1, hasTouch: true });
  await page.evaluateOnNewDocument(INSTALL_STUBS);
  if (passphrase || hideTop != null) {
    const pass = passphrase || "";
    const hide = !!hideTop;
    await page.evaluateOnNewDocument((pass, hide) => {
      if (pass) localStorage.setItem("nsb:passphrase", pass);
      if (hide) localStorage.setItem("nsb:prefs", JSON.stringify({ hideTop: true }));
    }, pass, hide);
  }
  if (!liveNotes) await stubNotesApi(page);
  await page.goto(base + "/episode.html?ep=" + SLUG, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => {
    const btn = document.getElementById("btn-doubt");
    const top = document.getElementById("top");
    return btn && top && !top.hidden && document.querySelectorAll(".ln").length > 50;
  }, { timeout: 30000 });
  if (extras) await extras(page);
  return { ctx, page };
}

async function seekTo(page, t) {
  await page.evaluate((t) => {
    const s = document.getElementById("seek");
    s.value = String(t);
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }, t);
  await page.waitForFunction((t) => {
    const a = document.getElementById("audio");
    return Math.abs((a.currentTime || 0) - t) < 1;
  }, { timeout: 5000 }, t).catch(() => {});
}

async function openMeaningAt(page, t) {
  await seekTo(page, t);
  await page.evaluate(() => { window.__ttsLog = []; window.__mediaLog = []; });
  await page.click("#btn-doubt");
  await page.waitForFunction(() => !document.getElementById("meaning").hidden, { timeout: 5000 });
}

async function waitSpoken(page, timeout = 2000) {
  await page.waitForFunction(() => {
    const tts = (window.__ttsLog || []).some((x) => x.typ === "speak");
    const clip = (window.__mediaLog || []).some((x) => (x.id === "es-audio" || /\/es\/\d+\.mp3/.test(x.src || "")) && x.typ === "play");
    return tts || clip;
  }, { timeout });
}
async function waitCountdown(page) {
  await page.waitForFunction(() => {
    const l = document.getElementById("m-go-label");
    return l && /Continuar · \d+/.test(l.textContent);
  }, { timeout: 5000 });
}

async function notesSnapshot(page) {
  return page.evaluate((slug) => {
    const raw = localStorage.getItem("nsb:notes:" + slug);
    let local = 0;
    try {
      const j = JSON.parse(raw || "null") || {};
      const pendingAdds = (j.pending || []).filter((op) => op.action === "add" && !op.deleted);
      const pendingDels = new Set((j.pending || []).filter((op) => op.action === "delete").map((op) => op.id));
      const server = (j.server || []).filter((n) => !pendingDels.has(n.id));
      local = server.length + pendingAdds.length;
    } catch (e) { local = -1; }
    return {
      badge: document.getElementById("dudas-count")?.textContent,
      marked: document.querySelectorAll(".ln.marked").length,
      local,
    };
  }, SLUG);
}

async function meaningInfo(page) {
  return page.evaluate(() => ({
    hidden: document.getElementById("meaning").hidden,
    es: document.getElementById("m-es")?.textContent,
    no: document.getElementById("m-no")?.textContent,
    go: document.getElementById("m-go-label")?.textContent,
    kicker: document.getElementById("m-kicker")?.textContent,
    count: document.getElementById("m-count")?.hidden ? null : document.getElementById("m-count")?.textContent,
    tts: window.__ttsLog.filter((x) => x.typ === "speak").map((x) => x.text),
    esClips: (window.__mediaLog || []).filter((x) => x.typ === "play" && (x.id === "es-audio" || /\/es\/\d+\.mp3/.test(x.src || ""))),
    media: window.__mediaLog.slice(),
    audioT: document.getElementById("audio").currentTime,
    paused: document.getElementById("audio").paused,
    badge: document.getElementById("dudas-count")?.textContent,
  }));
}

async function run() {
  const server = await startServer();
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });

  const results = [];
  async function test(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - t0 });
      console.log("  PASS  " + name + "  (" + (Date.now() - t0) + " ms)");
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, error: e.stack || String(e) });
      console.log("  FAIL  " + name);
      console.log(e.stack || e);
    }
  }

  // Line at 9s is "Klokken nærmer seg midnatt." (start 8.6). Old -2s offset would mark line 0.
  const T_KLOKKEN = 9;
  const ES_KLOKKEN = "Se acerca la medianoche.";
  const NO_KLOKKEN = "Klokken nærmer seg midnatt.";
  const KLOKKEN_START = 8.6;
  const KLOKKEN_END = 11.6;

  await test("Spanish plays first when opening No entendí", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      await waitSpoken(page);
      const info = await meaningInfo(page);
      assert(!info.hidden, "meaning card should be open");
      assert(info.es.includes("medianoche") || info.es === ES_KLOKKEN, "shows Spanish: " + info.es);
      assert(info.no.includes("Klokken") || info.no === NO_KLOKKEN, "shows Norwegian: " + info.no);
      const spoke = (info.esClips && info.esClips.length >= 1) || info.tts.length >= 1;
      assert(spoke, "should have spoken Spanish via MP3 or TTS, tts=" + JSON.stringify(info.tts) + " clips=" + JSON.stringify(info.esClips));
      if (info.tts.length) assert(info.tts[0].includes("medianoche") || info.tts[0] === ES_KLOKKEN, "first TTS is Spanish, got " + info.tts[0]);
      if (info.esClips.length) assert(/\/es\/1\.mp3/.test(info.esClips[0].src || ""), "clip should be line 1, got " + info.esClips[0].src);
      assert(info.kicker.toLowerCase().includes("significa"), "kicker: " + info.kicker);
    } finally { await ctx.close(); }
  });

  await test("marks the current line, not the previous one (no -2s offset)", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      const info = await meaningInfo(page);
      assert(info.no.includes("Klokken"), "should mark Klokken line, got: " + info.no);
      assert(!info.no.includes("podcast"), "must not mark the previous line");
    } finally { await ctx.close(); }
  });

  await test("screen waits after Spanish; no auto-advance before the timeout", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      await waitCountdown(page);
      const mid = await meaningInfo(page);
      assert(!mid.hidden, "should still be open when countdown starts");
      assert(/Continuar · [1-8]/.test(mid.go), "countdown on Continuar, got: " + mid.go);
      await sleep(2000);
      const later = await meaningInfo(page);
      assert(!later.hidden, "must not auto-advance 2s into the 8s timeout");
      assert(/Continuar · \d+/.test(later.go), "countdown still running: " + later.go);
    } finally { await ctx.close(); }
  });

  await test("auto-continue closes the card after ~8 seconds if nothing is pressed", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      await waitCountdown(page);
      await page.waitForFunction(() => document.getElementById("meaning").hidden, { timeout: 12000 });
      const info = await meaningInfo(page);
      assert(info.hidden, "meaning should have closed after the timeout");
    } finally { await ctx.close(); }
  });

  await test("any tap cancels auto-continue and the screen then waits", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      await waitCountdown(page);
      await page.click("#m-btn-es");
      const afterTap = await meaningInfo(page);
      assert(!afterTap.hidden, "still open after tap");
      assert(afterTap.go === "Continuar", "countdown label cleared, got: " + afterTap.go);
      await sleep(9000);
      const later = await meaningInfo(page);
      assert(!later.hidden, "must not auto-continue after the timeout was cancelled");
      assert(later.go === "Continuar", "label stays Continuar");
    } finally { await ctx.close(); }
  });

  await test("ES button replays Spanish TTS", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      await waitCountdown(page);
      const before = await meaningInfo(page);
      const beforeN = Math.max(before.tts.length, (before.esClips || []).length);
      await page.click("#m-btn-es");
      await page.waitForFunction((n) => {
        const tts = (window.__ttsLog || []).filter((x) => x.typ === "speak").length;
        const clips = (window.__mediaLog || []).filter((x) => x.typ === "play" && (x.id === "es-audio" || /\/es\/\d+\.mp3/.test(x.src || ""))).length;
        return Math.max(tts, clips) > n;
      }, { timeout: 3000 }, beforeN);
      const info = await meaningInfo(page);
      const speaks = info.tts;
      const clips = info.esClips || [];
      assert(speaks.length >= 2 || clips.length >= 2, "expected a second Spanish play, tts=" + speaks.length + " clips=" + clips.length);
      if (speaks.length) assert(speaks[speaks.length - 1].includes("medianoche"), "replay is Spanish: " + speaks[speaks.length - 1]);
      assert(!info.hidden, "card stays open");
    } finally { await ctx.close(); }
  });

  await test("NO button plays only the Norwegian line segment, then stops", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      await waitCountdown(page);
      await page.evaluate(() => { window.__mediaLog = []; });
      await page.click("#m-btn-no");
      await page.waitForFunction(() => window.__mediaLog.some((x) => x.typ === "play"), { timeout: 3000 });
      const atStart = await page.evaluate(() => document.getElementById("audio").currentTime);
      assert(Math.abs(atStart - KLOKKEN_START) < 0.3, "should seek to line start " + KLOKKEN_START + ", got " + atStart);
      const playing = await page.evaluate(() => !document.getElementById("audio").paused);
      assert(playing, "Norwegian segment should be playing");
      await page.evaluate((end) => {
        const a = document.getElementById("audio");
        a.currentTime = end + 0.2;
        a.dispatchEvent(new Event("timeupdate"));
      }, KLOKKEN_END);
      await page.waitForFunction(() => document.getElementById("audio").paused, { timeout: 3000 });
      const after = await meaningInfo(page);
      assert(after.paused, "should stop at line end");
      assert(Math.abs(after.audioT - KLOKKEN_END) < 0.4, "should stop near line end, got " + after.audioT);
      assert(!after.hidden, "replay must not close the card");
    } finally { await ctx.close(); }
  });

  await test("Continuar resumes playback where it was", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await seekTo(page, T_KLOKKEN);
      await page.evaluate(() => document.getElementById("audio").play());
      await openMeaningAt(page, T_KLOKKEN);
      await waitCountdown(page);
      // Move away by replaying Norwegian, then continue — should restore resumeAt.
      await page.click("#m-btn-no");
      await page.waitForFunction(() => window.__mediaLog.some((x) => x.typ === "play"), { timeout: 3000 });
      await page.click("#m-go");
      await page.waitForFunction(() => document.getElementById("meaning").hidden, { timeout: 3000 });
      const st = await page.evaluate(() => ({
        t: document.getElementById("audio").currentTime,
        paused: document.getElementById("audio").paused,
      }));
      assert(Math.abs(st.t - T_KLOKKEN) < 0.6, "should resume at " + T_KLOKKEN + ", got " + st.t);
      assert(!st.paused, "should resume playing because it was playing before");
    } finally { await ctx.close(); }
  });

  await test("only an explicit No entendí press adds a mark, at most once per line", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      let snap = await notesSnapshot(page);
      assert(String(snap.badge) === "1", "one mark after first press, badge=" + snap.badge);
      assert(snap.marked === 1, "one line marked, got " + snap.marked);
      // Pressing the button again while the card is open must not add another.
      await page.evaluate(() => document.getElementById("btn-doubt").click());
      snap = await notesSnapshot(page);
      assert(String(snap.badge) === "1", "no duplicate while open, badge=" + snap.badge);
      // Replay buttons must not add marks.
      await page.click("#m-btn-es");
      await page.click("#m-btn-no");
      snap = await notesSnapshot(page);
      assert(String(snap.badge) === "1", "replays do not add marks");
      await page.click("#m-go");
      await page.waitForFunction(() => document.getElementById("meaning").hidden);
      // Second explicit press on the same line must not duplicate.
      await page.click("#btn-doubt");
      await page.waitForFunction(() => !document.getElementById("meaning").hidden);
      snap = await notesSnapshot(page);
      assert(String(snap.badge) === "1", "second press on same line does not duplicate, badge=" + snap.badge);
      await page.click("#m-go");
      await page.waitForFunction(() => document.getElementById("meaning").hidden);
      // A different line gets its own mark.
      await openMeaningAt(page, 0.5);
      snap = await notesSnapshot(page);
      assert(String(snap.badge) === "2", "a different line can be marked, badge=" + snap.badge);
    } finally { await ctx.close(); }
  });

  await test("Ya entiendo removes the mark locally and syncs the delete", async () => {
    const before = await fetchNotes();
    const beforeIds = new Set(before.map((n) => n.id));
    const { ctx, page } = await openEpisode(browser, base, { passphrase: PASS, liveNotes: true });
    let createdIds = [];
    try {
      const startSnap = await notesSnapshot(page);
      const startCount = Number(startSnap.badge) || 0;
      await openMeaningAt(page, T_KLOKKEN);
      let snap = await notesSnapshot(page);
      assert(Number(snap.badge) === startCount + 1, "mark added, badge=" + snap.badge + " from " + startCount);
      // Give the worker a moment to accept the add if the passphrase works.
      await sleep(2500);
      await page.click("#m-gotit");
      await page.waitForFunction(() => document.getElementById("meaning").hidden, { timeout: 5000 });
      snap = await notesSnapshot(page);
      assert(Number(snap.badge) === startCount, "local badge should return to " + startCount + " after Ya entiendo, got " + snap.badge);
      // Wait until the worker no longer has notes we created.
      const deadline = Date.now() + 25000;
      let leftover = [];
      while (Date.now() < deadline) {
        const now = await fetchNotes();
        leftover = now.filter((n) => !beforeIds.has(n.id));
        createdIds = leftover.map((n) => n.id);
        if (leftover.length === 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      // Cleanup anything we still own, then assert empty of our notes.
      for (const id of createdIds) await deleteNote(id);
      const finalLeft = (await fetchNotes()).filter((n) => !beforeIds.has(n.id));
      assert(finalLeft.length === 0, "test notes must not remain on the worker: " + JSON.stringify(finalLeft));
    } catch (e) {
      try {
        const now = await fetchNotes();
        for (const n of now) {
          if (!beforeIds.has(n.id)) await deleteNote(n.id);
        }
      } catch (cleanupErr) { console.error("cleanup failed", cleanupErr); }
      throw e;
    } finally { await ctx.close(); }
  });

  await test("review opens the card, plays Spanish first, and never adds marks", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      await page.click("#m-go");
      await page.waitForFunction(() => document.getElementById("meaning").hidden);
      let snap = await notesSnapshot(page);
      assert(String(snap.badge) === "1", "need one existing mark to review");
      await page.click("#btn-dudas");
      await page.waitForFunction(() => !document.getElementById("panel").hidden);
      await page.evaluate(() => { window.__ttsLog = []; });
      await page.click("#btn-review");
      await page.waitForFunction(() => !document.getElementById("meaning").hidden, { timeout: 5000 });
      await waitSpoken(page);
      const info = await meaningInfo(page);
      assert(info.count && /Duda 1 de 1/.test(info.count), "review count, got " + info.count);
      const reviewSpoke = (info.esClips && info.esClips.length >= 1) || (info.tts.length >= 1 && info.tts[0].includes("medianoche"));
      assert(reviewSpoke, "review speaks Spanish first: tts=" + JSON.stringify(info.tts) + " clips=" + JSON.stringify(info.esClips));
      await page.click("#m-btn-es");
      await page.click("#m-btn-no");
      snap = await notesSnapshot(page);
      assert(String(snap.badge) === "1", "review/replay must not add marks, badge=" + snap.badge);
      await page.click("#m-go");
      await page.waitForFunction(() => document.getElementById("meaning").hidden, { timeout: 5000 });
      snap = await notesSnapshot(page);
      assert(String(snap.badge) === "1", "Continuar in review must not add or remove a mark");
    } finally { await ctx.close(); }
  });

  await test("meaning buttons sit in one unwrapped row at Tesla viewports", async () => {
    const viewports = [
      { w: 1100, h: 600 },
      { w: 1180, h: 700 },
      { w: 1920, h: 1200 },
      { w: 1200, h: 1600 },
    ];
    for (const vp of viewports) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1, hasTouch: true });
      await page.evaluateOnNewDocument(INSTALL_STUBS);
      await stubNotesApi(page);
      await page.goto(base + "/episode.html?ep=" + SLUG, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForFunction(() => document.getElementById("btn-doubt") && document.querySelectorAll(".ln").length > 50, { timeout: 30000 });
      await openMeaningAt(page, T_KLOKKEN);
      const layout = await page.evaluate(() => {
        const ids = ["m-btn-no", "m-btn-es", "m-gotit", "m-go"];
        const btns = ids.map((id) => {
          const b = document.getElementById(id);
          const r = b.getBoundingClientRect();
          return { id, text: b.innerText.replace(/\s+/g, " ").trim(), x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
        });
        const row = document.querySelector(".meaning-actions");
        const rr = row.getBoundingClientRect();
        const card = document.querySelector(".meaning-card").getBoundingClientRect();
        const wrap = window.getComputedStyle(row).flexWrap;
        const tops = btns.map((b) => Math.round(b.y));
        const sameRow = Math.max(...tops) - Math.min(...tops) < 8;
        const overflow = btns.some((b) => b.right > card.right + 2 || b.bottom > card.bottom + 2 || b.x < card.x - 2);
        return {
          order: btns.map((b) => b.id),
          labels: btns.map((b) => b.text),
          tops, sameRow, wrap, overflow,
          rowW: rr.width, cardW: card.width,
        };
      });
      try {
        assert(layout.order.join(",") === "m-btn-no,m-btn-es,m-gotit,m-go", vp.w + "x" + vp.h + " order " + layout.order);
        assert(/^NO\b/.test(layout.labels[0]) && /^ES\b/.test(layout.labels[1]), "labels " + layout.labels);
        assert(/Ya entiendo/i.test(layout.labels[2]), "Ya entiendo label: " + layout.labels[2]);
        assert(/Continuar/i.test(layout.labels[3]), "Continuar label: " + layout.labels[3]);
        assert(layout.wrap === "nowrap", vp.w + "x" + vp.h + " flex-wrap is " + layout.wrap);
        assert(layout.sameRow, vp.w + "x" + vp.h + " buttons wrapped, tops=" + layout.tops);
        assert(!layout.overflow, vp.w + "x" + vp.h + " buttons overflow the card");
      } finally { await ctx.close(); }
    }
  });

  await test("top bar hide, unhide, persistence, and back button", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      const start = await page.evaluate(() => {
        const hub = document.getElementById("btn-hub");
        const top = document.getElementById("top");
        const hide = document.getElementById("btn-hide-top");
        const un = document.getElementById("btn-unhide");
        const hubBox = hub.getBoundingClientRect();
        const use = hub.querySelector("svg use");
        return {
          hiddenClass: document.documentElement.classList.contains("top-hidden"),
          topVisible: !!(top && !top.hidden && top.getBoundingClientRect().height > 20),
          hubVisible: hubBox.width > 0 && hubBox.height > 0,
          hubHref: hub.getAttribute("href"),
          hubText: hub.innerText.replace(/\s+/g, " ").trim(),
          hubIcon: use && (use.getAttribute("href") || use.getAttribute("xlink:href")),
          hideLabel: hide && hide.getAttribute("aria-label"),
          unSize: { w: un.getBoundingClientRect().width, h: un.getBoundingClientRect().height },
          unVisible: (() => { const s = getComputedStyle(un); return s.opacity !== "0" && s.pointerEvents !== "none"; })(),
        };
      });
      assert(!start.hiddenClass, "top bar starts visible");
      assert(start.topVisible, "top bar has height");
      assert(start.hubVisible, "back button is visible");
      assert(start.hubHref === "./", "back href is ./ , got " + start.hubHref);
      assert(/Atrás/i.test(start.hubText), "back button is labeled Atrás, got " + start.hubText);
      assert(start.hubIcon === "#i-left", "back uses left-arrow SVG, got " + start.hubIcon);
      assert(!start.unVisible, "unhide should be hidden while the bar is shown");

      await page.click("#btn-hide-top");
      await page.waitForFunction(() => document.documentElement.classList.contains("top-hidden"));
      const mid = await page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => {
          const top = document.getElementById("top");
          const slot = document.getElementById("top-slot");
          const cs = getComputedStyle(top);
          resolve({
            transform: cs.transform,
            opacity: cs.opacity,
            slotH: slot ? slot.getBoundingClientRect().height : null,
          });
        }, 80);
      }));
      assert(mid.transform && mid.transform !== "none", "bar should be sliding, transform=" + mid.transform);
      assert(Number(mid.opacity) > 0.9, "no fade on the bar, opacity=" + mid.opacity);
      await page.waitForFunction(() => document.documentElement.classList.contains("top-hidden-done"), { timeout: 2000 });
      const hidden = await page.evaluate(() => {
        const top = document.getElementById("top");
        const un = document.getElementById("btn-unhide");
        const stage = document.getElementById("stage");
        const ub = un.getBoundingClientRect();
        const s = getComputedStyle(un);
        const tr = top.getBoundingClientRect();
        const cs = getComputedStyle(top);
        const band = [];
        for (const el of document.querySelectorAll("body *")) {
          if (el === un || un.contains(el)) continue;
          if (stage === el || stage.contains(el)) continue;
          if (el.hidden || el.getAttribute("hidden") != null) continue;
          const r = el.getBoundingClientRect();
          if (r.height <= 0 || r.width <= 0) continue;
          const st = getComputedStyle(el);
          if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") continue;
          if (r.top < 60 && r.bottom > 0 && r.left < window.innerWidth && r.right > 0) {
            band.push((el.id ? "#" + el.id : el.tagName) + (el.className && typeof el.className === "string" ? "." + String(el.className).trim().split(/\s+/).join(".") : ""));
          }
        }
        return {
          topH: tr.height,
          topDisplay: cs.display,
          topBorder: cs.borderBottomWidth,
          topPad: cs.paddingTop + "/" + cs.paddingBottom,
          unVisible: s.opacity !== "0" && s.pointerEvents !== "none",
          unW: Math.round(ub.width),
          unH: Math.round(ub.height),
          stored: JSON.parse(localStorage.getItem("nsb:prefs") || "{}").hideTop,
          done: document.documentElement.classList.contains("top-hidden-done"),
          band,
        };
      });
      assert(hidden.topH === 0, "top bar height must be 0, got " + hidden.topH);
      assert(hidden.topDisplay === "none" || (hidden.topBorder === "0px" && hidden.topPad === "0px/0px"), "no remnant strip, display=" + hidden.topDisplay + " border=" + hidden.topBorder + " pad=" + hidden.topPad);
      assert(hidden.unVisible, "unhide button should appear");
      assert(hidden.unW >= 48 && hidden.unH >= 48, "unhide at least 48px, got " + hidden.unW + "x" + hidden.unH);
      assert(hidden.stored === true, "hideTop saved in localStorage");
      assert(hidden.band.length === 0, "only unhide (and transcript) may sit in the top 60px, found " + JSON.stringify(hidden.band));

      await page.click("#btn-unhide");
      await page.waitForFunction(() => !document.documentElement.classList.contains("top-hidden"));
      await sleep(400);
      const shown = await page.evaluate(() => {
        const top = document.getElementById("top");
        const cs = getComputedStyle(top);
        return {
          topH: top.getBoundingClientRect().height,
          hub: document.getElementById("btn-hub").getBoundingClientRect().height,
          transform: cs.transform,
          stored: JSON.parse(localStorage.getItem("nsb:prefs") || "{}").hideTop,
        };
      });
      assert(shown.topH > 20, "top bar returns, height=" + shown.topH);
      assert(shown.hub > 20, "back button visible again");
      assert(shown.transform === "none" || shown.transform === "matrix(1, 0, 0, 1, 0, 0)", "bar should sit in place after show, transform=" + shown.transform);
      assert(shown.stored === false, "hideTop cleared in localStorage");

      // Persistence: hide, then reload (stubs reinstalled on new document).
      await page.click("#btn-hide-top");
      await page.waitForFunction(() => document.documentElement.classList.contains("top-hidden"));
      await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForFunction(() => document.getElementById("btn-unhide"), { timeout: 30000 });
      await page.waitForFunction(() => document.documentElement.classList.contains("top-hidden-done") || document.getElementById("top")?.getBoundingClientRect().height === 0, { timeout: 5000 });
      const persisted = await page.evaluate(() => ({
        cls: document.documentElement.classList.contains("top-hidden"),
        topH: document.getElementById("top")?.getBoundingClientRect().height || 0,
        stored: JSON.parse(localStorage.getItem("nsb:prefs") || "{}").hideTop,
      }));
      assert(persisted.cls && persisted.stored, "hidden state should persist after reload");
      assert(persisted.topH === 0, "top bar stays gone after reload, height=" + persisted.topH);

      // Back navigation from a visible bar.
      await page.click("#btn-unhide");
      await page.waitForFunction(() => !document.documentElement.classList.contains("top-hidden"));
      await sleep(400);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }),
        page.click("#btn-hub"),
      ]);
      const url = page.url();
      assert(/\/(index\.html)?(\?|$)/.test(url.replace(/https?:\/\/[^/]+/, "")) || url.endsWith("/"), "should navigate to the hub, got " + url);
      const home = await page.evaluate(() => document.body.classList.contains("home-page") || !!document.querySelector("h1"));
      assert(home, "hub page should load");
    } finally { await ctx.close(); }
  });

  await test("Cerrar sits at the top-right of the meaning card", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      const pos = await page.evaluate(() => {
        const card = document.querySelector(".meaning-card").getBoundingClientRect();
        const btn = document.getElementById("m-close").getBoundingClientRect();
        const kicker = document.getElementById("m-kicker").getBoundingClientRect();
        return {
          cardRight: card.right, cardTop: card.top, cardMid: card.left + card.width / 2,
          btnRight: btn.right, btnTop: btn.top, btnLeft: btn.left,
          kickerRight: kicker.right,
        };
      });
      assert(pos.btnLeft > pos.cardMid, "Cerrar should be on the right half, left=" + pos.btnLeft + " mid=" + pos.cardMid);
      assert(pos.cardRight - pos.btnRight < 32, "Cerrar should sit near the right edge, gap=" + (pos.cardRight - pos.btnRight));
      assert(pos.btnTop - pos.cardTop < 36, "Cerrar should sit near the top, gap=" + (pos.btnTop - pos.cardTop));
      assert(pos.btnLeft >= pos.kickerRight - 1, "Cerrar should not sit in the middle of the title");
    } finally { await ctx.close(); }
  });

  await test("real Norwegian audio plays and resumes after Spanish TTS", async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    try {
      await page.setViewport({ width: 1180, height: 700, deviceScaleFactor: 1, hasTouch: true });
      await page.evaluateOnNewDocument(() => {
        window.__ttsTrace = [];
        const wrap = () => {
          if (!window.speechSynthesis || window.__ttsWrapped) return;
          window.__ttsWrapped = true;
          const s = window.speechSynthesis;
          const origCancel = s.cancel.bind(s);
          const origSpeak = s.speak.bind(s);
          s.cancel = function () { window.__ttsTrace.push({ typ: "cancel", t: performance.now() }); return origCancel(); };
          s.speak = function (u) {
            window.__ttsTrace.push({ typ: "speak", t: performance.now(), lang: u.lang, rate: u.rate, volume: u.volume, hasVoice: !!u.voice });
            return origSpeak(u);
          };
        };
        wrap();
        document.addEventListener("DOMContentLoaded", wrap);
      });
      await stubNotesApi(page);
      await page.goto(base + "/episode.html?ep=" + SLUG, { waitUntil: "networkidle2", timeout: 60000 });
      await page.waitForFunction(() => document.getElementById("btn-play") && document.querySelectorAll(".ln").length > 50, { timeout: 30000 });

      const snap = () => page.evaluate(() => {
        const a = document.getElementById("audio");
        return { paused: a.paused, muted: a.muted, volume: a.volume, t: a.currentTime, ready: a.readyState, err: a.error && a.error.message };
      });

      await page.click("#btn-play");
      await page.waitForFunction(() => {
        const a = document.getElementById("audio");
        return !a.paused && a.currentTime > 0.2;
      }, { timeout: 20000 });
      const a1 = await snap();
      const t1 = a1.t;
      await sleep(1200);
      const a2 = await snap();
      assert(!a2.paused, "Play should leave the episode playing");
      assert(a2.volume > 0 && !a2.muted, "volume must be audible after Play, volume=" + a2.volume + " muted=" + a2.muted);
      assert(a2.t > t1 + 0.4, "currentTime should advance, " + t1 + " -> " + a2.t);

      await page.click("#btn-doubt");
      await page.waitForFunction(() => !document.getElementById("meaning").hidden, { timeout: 5000 });
      // NRK should pause; the Spanish MP3 should play.
      await page.waitForFunction(() => {
        const a = document.getElementById("audio");
        const es = document.getElementById("es-audio");
        return a.paused && es && !es.paused && es.volume > 0 && !es.muted;
      }, { timeout: 10000 });
      const mid = await page.evaluate(() => {
        const a = document.getElementById("audio");
        const es = document.getElementById("es-audio");
        return { nrkPaused: a.paused, esPaused: es.paused, esVol: es.volume, esMuted: es.muted, esT: es.currentTime, esSrc: es.currentSrc || es.src };
      });
      assert(mid.nrkPaused, "NRK must pause while the Spanish clip plays");
      assert(/\/es\/\d+\.mp3/.test(mid.esSrc || ""), "should play a pre-recorded Spanish MP3, src=" + mid.esSrc);
      const esT0 = mid.esT;
      await sleep(600);
      const mid2 = await page.evaluate(() => {
        const es = document.getElementById("es-audio");
        return { t: es.currentTime, paused: es.paused };
      });
      assert(!mid2.paused || mid2.t > esT0, "Spanish clip should advance or already have finished, " + esT0 + " -> " + mid2.t);
      await page.waitForFunction(() => {
        const l = document.getElementById("m-go-label");
        const es = document.getElementById("es-audio");
        return l && /Continuar · \d+/.test(l.textContent) && es && es.paused;
      }, { timeout: 20000 });
      const afterClip = await page.evaluate(() => ({
        go: document.getElementById("m-go-label")?.textContent,
        nrkPaused: document.getElementById("audio").paused,
        esPaused: document.getElementById("es-audio").paused,
      }));
      assert(/Continuar · \d+/.test(afterClip.go || ""), "countdown starts after the Spanish clip ends, go=" + afterClip.go);
      assert(afterClip.nrkPaused, "NRK stays paused until Continuar");

      await page.click("#m-go");
      await page.waitForFunction(() => document.getElementById("meaning").hidden, { timeout: 5000 });
      await page.waitForFunction(() => {
        const a = document.getElementById("audio");
        return !a.paused && a.volume > 0 && !a.muted;
      }, { timeout: 10000 });
      const b1 = await snap();
      await sleep(1200);
      const b2 = await snap();
      assert(b2.volume > 0 && !b2.muted, "after Continuar, audio must not stay muted or at volume 0");
      assert(!b2.paused, "after Continuar, playback should resume");
      assert(b2.t > b1.t + 0.4, "after Continuar, currentTime should advance, " + b1.t + " -> " + b2.t);
    } finally { await ctx.close(); }
  });

  await test("countdown still starts when there is no Spanish voice", async () => {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    try {
      await page.setViewport({ width: 1180, height: 700, deviceScaleFactor: 1, hasTouch: true });
      await page.evaluateOnNewDocument(() => {
        window.__INSTALL_STUBS = true;
        const stub = {
          cancel() {},
          speak() {},
          getVoices() { return []; },
          addEventListener() {},
          removeEventListener() {},
        };
        Object.defineProperty(window, "speechSynthesis", { configurable: true, get() { return stub; } });
      });
      await stubNotesApi(page);
      await page.goto(base + "/episode.html?ep=" + SLUG, { waitUntil: "networkidle2", timeout: 30000 });
      await page.waitForFunction(() => document.getElementById("btn-play") && document.querySelectorAll(".ln").length > 50, { timeout: 30000 });
      const t0 = Date.now();
      await openMeaningAt(page, T_KLOKKEN);
      await page.waitForFunction(() => {
        const l = document.getElementById("m-go-label");
        return l && /Continuar · \d+/.test(l.textContent);
      }, { timeout: 15000 });
      const toasts = await page.evaluate(() => Array.from(document.querySelectorAll(".toast")).map((n) => n.textContent));
      assert(!toasts.some((x) => /no puede leer|no hay voz|voz/i.test(x || "")), "must not show a broken-voice toast, got " + JSON.stringify(toasts));
    } finally { await ctx.close(); }
  });

  await test("previous and next lines sit as faint context around the main line", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      const info = await page.evaluate(() => {
        const card = document.querySelector(".meaning-card").getBoundingClientRect();
        const prev = document.getElementById("m-prev");
        const next = document.getElementById("m-next");
        const es = document.getElementById("m-es");
        const no = document.getElementById("m-no");
        const pr = prev.getBoundingClientRect();
        const nr = next.getBoundingClientRect();
        const er = es.getBoundingClientRect();
        const nor = no.getBoundingClientRect();
        const prevNo = prev.querySelector(".ctx-no");
        const prevEs = prev.querySelector(".ctx-es");
        const nextNo = next.querySelector(".ctx-no");
        const nextEs = next.querySelector(".ctx-es");
        const csNo = prevNo ? getComputedStyle(prevNo) : null;
        const csEs = prevEs ? getComputedStyle(prevEs) : null;
        const lum = (c) => {
          const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (!m) return 1;
          return (Number(m[1]) + Number(m[2]) + Number(m[3])) / (3 * 255);
        };
        const ids = ["m-btn-no", "m-btn-es", "m-gotit", "m-go"];
        const ys = ids.map((id) => Math.round(document.getElementById(id).getBoundingClientRect().y));
        return {
          prevHidden: prev.hidden,
          nextHidden: next.hidden,
          prevNo: prevNo && prevNo.textContent,
          prevEs: prevEs && prevEs.textContent,
          nextNo: nextNo && nextNo.textContent,
          nextEs: nextEs && nextEs.textContent,
          prevBottom: pr.bottom,
          esTop: er.top,
          noBottom: nor.bottom,
          nextTop: nr.top,
          prevLum: csNo && lum(csNo.color),
          prevEsLum: csEs && lum(csEs.color),
          mainLum: lum(getComputedStyle(no).color),
          wrapDelta: Math.max(...ys) - Math.min(...ys),
          cardH: card.height,
          viewH: window.innerHeight,
          overflowY: ys.some((y) => y > window.innerHeight - 4),
          labels: ["Antes", "Después"].filter((w) => (prev.textContent + next.textContent).includes(w)),
        };
      });
      assert(!info.prevHidden && !info.nextHidden, "both context lines should be visible");
      assert(/podcast fra NRK/i.test(info.prevNo || ""), "previous Norwegian above, got " + info.prevNo);
      assert(/pódcast de NRK|podcast de NRK/i.test(info.prevEs || ""), "previous Spanish under it, got " + info.prevEs);
      assert(/legger hodet/i.test(info.nextNo || ""), "next Norwegian below, got " + info.nextNo);
      assert(/almohada/i.test(info.nextEs || ""), "next Spanish under it, got " + info.nextEs);
      assert(info.prevBottom <= info.esTop + 2, "previous line must sit ABOVE the main text");
      assert(info.nextTop >= info.noBottom - 2, "next line must sit BELOW the main text");
      assert(info.prevLum < info.mainLum - 0.15, "context Norwegian should be fainter than the main line, " + info.prevLum + " vs " + info.mainLum);
      assert(info.prevEsLum <= info.prevLum + 0.02, "context Spanish should be fainter or equal, " + info.prevEsLum + " vs " + info.prevLum);
      assert(info.wrapDelta < 8, "buttons must stay in one row, wrapDelta=" + info.wrapDelta);
      assert(!info.overflowY, "buttons should remain on screen at 1180x700");
      assert(info.labels.length === 0, "context should not use Antes/Después labels, got " + JSON.stringify(info.labels));
    } finally { await ctx.close(); }
  });

  await test("transcript words are not tappable and a line tap still seeks", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      const before = await page.evaluate(() => ({
        words: document.querySelectorAll(".ln .word, .stage .word, main .word").length,
        t: document.getElementById("audio").currentTime,
      }));
      assert(before.words === 0, "transcript must not have tappable word spans, found " + before.words);
      const target = await page.evaluate(() => {
        const ln = document.querySelector('.ln[data-i="20"]') || document.querySelectorAll(".ln")[20];
        if (!ln) return null;
        ln.click();
        return { i: ln.getAttribute("data-i"), startHint: ln.querySelector(".t")?.textContent };
      });
      assert(target, "expected a transcript line to click");
      await page.waitForFunction((prev) => Math.abs((document.getElementById("audio").currentTime || 0) - prev) > 1, { timeout: 4000 }, before.t).catch(() => {});
      const after = await page.evaluate(() => ({
        t: document.getElementById("audio").currentTime,
        words: document.querySelectorAll(".ln .word").length,
        meaningOpen: !document.getElementById("meaning").hidden,
        hintOpen: document.getElementById("word-hint") && !document.getElementById("word-hint").hidden,
      }));
      assert(after.t > 10, "clicking a line should seek, currentTime=" + after.t);
      assert(after.words === 0, "seeking must not create word spans in the transcript");
      assert(!after.meaningOpen && !after.hintOpen, "line tap must not open the hint or meaning card");
    } finally { await ctx.close(); }
  });

  await test("tapping a Norwegian word on the meaning card opens a mini hint", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      // Line with «håndtere» / «bekymringer» in the episode vocabulary (starts 77.62).
      await openMeaningAt(page, 80);
      await waitCountdown(page);
      const setup = await page.evaluate(() => {
        const noWords = [...document.querySelectorAll("#m-no button.word")].map((b) => b.dataset.word);
        const ctxWords = [...document.querySelectorAll("#m-prev button.word, #m-next button.word")].map((b) => b.dataset.word);
        return { noWords, ctxWords, meaningOpen: !document.getElementById("meaning").hidden };
      });
      assert(setup.meaningOpen, "meaning card should be open");
      assert(setup.noWords.length > 0, "Norwegian line should have tappable words");
      assert(setup.noWords.some((w) => /h[åa]ndtere/i.test(w)), "expected håndtere among " + setup.noWords.join(","));
      assert(setup.ctxWords.length > 0, "context lines should have tappable words");

      const beforeNotes = await notesSnapshot(page);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("#m-no button.word")].find((b) => /h[åa]ndtere/i.test(b.dataset.word));
        btn.click();
      });
      await page.waitForFunction(() => document.getElementById("word-hint") && !document.getElementById("word-hint").hidden, { timeout: 5000 });
      const hint = await page.evaluate(() => ({
        word: document.getElementById("wh-word")?.textContent,
        es: document.getElementById("wh-es")?.textContent,
        meaningOpen: !document.getElementById("meaning").hidden,
        go: document.getElementById("m-go-label")?.textContent,
        href: document.getElementById("wh-ordbok")?.getAttribute("href"),
        hasSpeak: !document.getElementById("wh-speak")?.hidden,
      }));
      assert(hint.meaningOpen, "hint must layer over the meaning card, not close it");
      assert(/h[åa]ndtere/i.test(hint.word), "hint shows the word, got " + hint.word);
      assert(/manejar|gestionar/i.test(hint.es), "vocab Spanish hint, got " + hint.es);
      assert(hint.go === "Continuar", "tapping a word cancels the auto-continue countdown");
      assert(hint.hasSpeak, "ES speak button should be visible when there is a Spanish hint");
      assert(/ordbokene\.no/i.test(hint.href || ""), "Ordbøkene link, got " + hint.href);
      const afterNotes = await notesSnapshot(page);
      assert(afterNotes.badge === beforeNotes.badge, "tapping a word must not add a mark");

      await page.click("#wh-close");
      await page.waitForFunction(() => document.getElementById("word-hint").hidden, { timeout: 3000 });
      const still = await page.evaluate(() => !document.getElementById("meaning").hidden);
      assert(still, "closing the hint leaves the meaning card open");
    } finally { await ctx.close(); }
  });

  await test("live Ordbøkene API fills word class or a definition when there is no vocab hit", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await openMeaningAt(page, T_KLOKKEN);
      const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("#m-no button.word")].find((b) => /medianoche|midnatt/i.test(b.dataset.word) || (b.dataset.word || "").toLowerCase() === "midnatt");
        if (!btn) return null;
        btn.click();
        return btn.dataset.word;
      });
      assert(clicked, "expected to click midnatt");
      await page.waitForFunction(() => {
        const box = document.getElementById("word-hint");
        if (!box || box.hidden) return false;
        const es = document.getElementById("wh-es")?.textContent || "";
        const def = document.getElementById("wh-def")?.textContent || "";
        const cls = document.getElementById("wh-class")?.textContent || "";
        if (es === "Buscando…") return false;
        return def.length > 0 || cls.length > 0 || es === "Sin resultados";
      }, { timeout: 15000 });
      const hint = await page.evaluate(() => ({
        word: document.getElementById("wh-word")?.textContent,
        es: document.getElementById("wh-es")?.textContent,
        def: document.getElementById("wh-def")?.textContent,
        cls: document.getElementById("wh-class")?.hidden ? "" : document.getElementById("wh-class")?.textContent,
      }));
      assert(hint.es !== "Buscando…", "lookup should finish");
      assert((hint.def && hint.def.length > 3) || (hint.cls && hint.cls.length > 0), "live API should return a class or definition, got " + JSON.stringify(hint));
    } finally { await ctx.close(); }
  });

  await test("Ajustes shows voice diagnostics and Probar voz ES plays an MP3", async () => {
    const { ctx, page } = await openEpisode(browser, base);
    try {
      await page.click("#btn-more");
      await page.waitForFunction(() => !document.getElementById("more").hidden);
      await page.click("#btn-settings");
      await page.waitForFunction(() => !document.getElementById("settings").hidden);
      const diag = await page.evaluate(() => document.getElementById("s-tts")?.textContent || "");
      assert(/Síntesis del navegador: (sí|no)/i.test(diag), "diag should report speechSynthesis, got " + diag);
      assert(/voces: \d+/i.test(diag), "diag should report a voice count, got " + diag);
      await page.evaluate(() => { window.__mediaLog = []; });
      await page.click("#s-test-es");
      await page.waitForFunction(() => {
        const es = document.getElementById("es-audio");
        const plays = (window.__mediaLog || []).some((x) => x.typ === "play" && (x.id === "es-audio" || /\/es\/\d+\.mp3/.test(x.src || "")));
        return plays || (es && es.src && /\/es\/\d+\.mp3/.test(es.src));
      }, { timeout: 8000 });
      const src = await page.evaluate(() => document.getElementById("es-audio").getAttribute("src") || document.getElementById("es-audio").src);
      assert(/\/es\/\d+\.mp3/.test(src || ""), "Probar voz ES should play a Spanish MP3, src=" + src);
    } finally { await ctx.close(); }
  });

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + results.length + " tests, " + (results.length - failed.length) + " passed, " + failed.length + " failed");
  if (failed.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
