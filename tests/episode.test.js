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
    window.__mediaLog.push({ typ: "play", t: this.currentTime });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  proto.pause = function () {
    pausedMap.set(this, true);
    window.__mediaLog.push({ typ: "pause", t: this.currentTime });
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
      const info = await meaningInfo(page);
      assert(!info.hidden, "meaning card should be open");
      assert(info.es.includes("medianoche") || info.es === ES_KLOKKEN, "shows Spanish: " + info.es);
      assert(info.no.includes("Klokken") || info.no === NO_KLOKKEN, "shows Norwegian: " + info.no);
      assert(info.tts.length >= 1, "should have spoken Spanish");
      assert(info.tts[0].includes("medianoche") || info.tts[0] === ES_KLOKKEN, "first TTS is Spanish, got " + info.tts[0]);
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
      const before = (await meaningInfo(page)).tts.length;
      await page.click("#m-btn-es");
      await page.waitForFunction((n) => window.__ttsLog.filter((x) => x.typ === "speak").length > n, { timeout: 3000 }, before);
      const info = await meaningInfo(page);
      const speaks = info.tts;
      assert(speaks.length >= 2, "expected a second TTS, got " + speaks.length);
      assert(speaks[speaks.length - 1].includes("medianoche"), "replay is Spanish: " + speaks[speaks.length - 1]);
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
      const info = await meaningInfo(page);
      assert(info.count && /Duda 1 de 1/.test(info.count), "review count, got " + info.count);
      assert(info.tts.length >= 1 && info.tts[0].includes("medianoche"), "review speaks Spanish first: " + JSON.stringify(info.tts));
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
      await sleep(500);
      const shown = await page.evaluate(() => ({
        topH: document.getElementById("top").getBoundingClientRect().height,
        hub: document.getElementById("btn-hub").getBoundingClientRect().height,
        stored: JSON.parse(localStorage.getItem("nsb:prefs") || "{}").hideTop,
      }));
      assert(shown.topH > 20, "top bar returns, height=" + shown.topH);
      assert(shown.hub > 20, "back button visible again");
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

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + results.length + " tests, " + (results.length - failed.length) + " passed, " + failed.length + " failed");
  if (failed.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
