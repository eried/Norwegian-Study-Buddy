// Norwegian Study Buddy: driving-friendly episode player (UI en español).
(function () {
  "use strict";
  const NSB = window.NSB;
  const { $, $$, el, fmtTime, toast, fetchJSON, lsGet, lsSet } = NSB;
  const cfg = window.NSB_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const slug = (params.get("ep") || "hvordan-unnga-tankekjor").replace(/[^a-z0-9-]/g, "");
  const PREFS_KEY = "nsb:prefs";
  const prefs = Object.assign({ es: true, autoSpeak: true, autoResume: true, follow: true, askedPass: false, rate: 1, voiceURI: "", hideTop: false }, lsGet(PREFS_KEY, {}));
  const savePrefs = () => lsSet(PREFS_KEY, prefs);

  const audio = $("#audio");
  const esAudio = $("#es-audio");
  const ES_AUDIO_V = "20261115d";
  let ep, lines = [], vocab = [], store, current = -1;

  // ---------- load ----------
  init().catch((e) => {
    $("#loading").textContent = "No se pudo cargar el episodio (" + e.message + ").";
    console.error(e);
  });

  async function init() {
    ep = await fetchJSON("episodes/" + slug + "/transcript.json");
    document.title = ep.title + " · Norwegian Study Buddy";
    $("#ep-title").textContent = ep.title;
    $("#ep-show").textContent = ep.show + " · NRK";
    ep.segments.forEach((s) => s.lines.forEach((l, i) => lines.push({ ...l, seg: s, segLine: i, idx: lines.length })));
    vocab = (ep.vocabulary || []).map((v) => ({ ...v, keys: vocabKeys(v.no) }));

    renderTranscript();
    renderVocab();
    applyEs();
    audio.preload = "auto";
    audio.src = ep.audioUrl;
    resolveAudioSrc(ep.audioUrl);
    $("#seek").max = ep.durationSec || 0;
    $("#t-dur").textContent = fmtTime(ep.durationSec);

    store = new NSB.NotesStore(slug, {
      workerUrl: cfg.workerUrl,
      fallbackUrl: "notes/" + slug + ".json",
      retryIntervalMs: cfg.retryIntervalMs,
    });
    store.on(onStoreChange);
    store.load();

    $("#loading").hidden = true;
    $("#top").hidden = false;
    $("#dock").hidden = false;
    setupMediaSession();
    wire();
    applyRate();
    applyTop();
    setCurrent(0, false);
  }

  // ---------- transcript ----------
  function renderTranscript() {
    const stage = $("#stage");
    const frag = document.createDocumentFragment();
    let lastSeg = null;
    for (const l of lines) {
      if (l.seg !== lastSeg) {
        lastSeg = l.seg;
        frag.append(el("div", { class: "seg-title" }, fmtTime(l.seg.start) + " · " + (l.seg.titleEs || l.seg.title), el("small", { lang: "en" }, l.seg.title)));
      }
      const b = el("button", { class: "ln", type: "button", "data-i": l.idx },
        el("span", { class: "t" }, fmtTime(l.start)),
        el("span", { class: "no", lang: "nb" }, l.text),
        el("span", { class: "es", lang: "es" }, l.es || ""));
      b.addEventListener("click", () => { seek(l.start); play(); });
      l.node = b;
      frag.append(b);
    }
    frag.append(el("p", { class: "note-mt" },
      "Traducción automática al español. ", ep.transcriptNoteEs || ep.transcriptNote || "", " ",
      el("a", { href: ep.episodeUrl, target: "_blank", rel: "noopener" }, "Escuchar en NRK"), " · ",
      el("a", { href: ep.showUrl || "https://radio.nrk.no/podkast/burde_vaert_pensum", target: "_blank", rel: "noopener" }, ep.show)));
    stage.append(frag);
    let t;
    const manual = () => {
      stage.dataset.manual = "1";
      stopLineScroll();
      clearTimeout(t);
      t = setTimeout(() => delete stage.dataset.manual, 5000);
    };
    stage.addEventListener("wheel", manual, { passive: true });
    stage.addEventListener("touchmove", manual, { passive: true });
  }

  // Smooth ease-in-out scroll of the transcript to the active line.
  // Native scrollIntoView({behavior:"smooth"}) steps on Tesla's Chromium.
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SCROLL_MS = 700;
  let scrollRaf = 0;
  function easeInOutCubic(u) {
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  }
  function stopLineScroll() {
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
  }
  function lineScrollTop(el, stage) {
    const cr = stage.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const mid = er.top - cr.top + stage.scrollTop + er.height / 2;
    const max = Math.max(0, stage.scrollHeight - stage.clientHeight);
    return Math.max(0, Math.min(max, mid - cr.height / 2));
  }
  function scrollLineIntoView(el) {
    const stage = $("#stage");
    if (!stage || stage.dataset.manual) return;
    const dest = lineScrollTop(el, stage);
    if (Math.abs(dest - stage.scrollTop) < 1.5) { stage.scrollTop = dest; return; }
    if (reduceMotion()) { stopLineScroll(); stage.scrollTop = dest; return; }
    stopLineScroll();
    const from = stage.scrollTop;
    const start = performance.now();
    const tick = (now) => {
      if (stage.dataset.manual) { scrollRaf = 0; return; }
      const u = Math.min(1, (now - start) / SCROLL_MS);
      stage.scrollTop = from + (dest - from) * easeInOutCubic(u);
      if (u < 1) scrollRaf = requestAnimationFrame(tick);
      else { stage.scrollTop = dest; scrollRaf = 0; }
    };
    scrollRaf = requestAnimationFrame(tick);
  }

  function lineAt(t) {
    let lo = 0, hi = lines.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function setCurrent(i, scroll = true) {
    if (i === current || !lines[i]) return;
    if (lines[current]) {
      lines[current].node.classList.remove("now");
      [current - 1, current + 1].forEach((j) => lines[j] && lines[j].node.classList.remove("near"));
    }
    current = i;
    const n = lines[i].node;
    n.classList.add("now");
    [i - 1, i + 1].forEach((j) => lines[j] && lines[j].node.classList.add("near"));
    if (scroll && prefs.follow && !$("#stage").dataset.manual) scrollLineIntoView(n);
  }

  // ---------- audio ----------
  function unlockAudio() {
    audio.muted = false;
    if (!(audio.volume > 0)) audio.volume = 1;
  }
  async function resolveAudioSrc(url) {
    if (!url) return;
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", mode: "cors", cache: "no-store" });
      if (!res.ok || !res.url || res.url === url) return;
      if (!audio.paused && audio.currentTime > 0.25) return;
      const t0 = audio.currentTime || 0;
      audio.src = res.url;
      if (t0 > 0) audio.currentTime = t0;
    } catch (e) { /* keep the original URL */ }
  }
  const play = () => {
    unlockAudio();
    const req = audio.play();
    if (req && req.catch) {
      req.catch((e) => {
        if (e.name === "AbortError") return;
        const retry = () => { audio.removeEventListener("canplay", retry); unlockAudio(); audio.play().catch((e2) => { if (e2.name !== "AbortError") toast("No se pudo reproducir el audio"); }); };
        audio.addEventListener("canplay", retry, { once: true });
        try { audio.load(); } catch (err) {}
      });
    }
  };
  const pause = () => audio.pause();
  const toggle = () => (audio.paused ? play() : pause());
  function seek(t) {
    const d = isFinite(audio.duration) ? audio.duration : ep.durationSec;
    audio.currentTime = Math.max(0, Math.min(d - 0.25, t));
    setCurrent(lineAt(audio.currentTime));
    updatePosition();
  }
  const skip = (s) => seek(audio.currentTime + s);
  function lineStep(dir) {
    const cur = lineAt(audio.currentTime);
    // "previous" restarts the current line if we are more than 1.5 s into it
    let target = cur + dir;
    if (dir < 0 && audio.currentTime - lines[cur].start > 1.5) target = cur;
    target = Math.max(0, Math.min(lines.length - 1, target));
    seek(lines[target].start);
  }

  audio.addEventListener("timeupdate", () => {
    if (clipEnd != null && audio.currentTime >= clipEnd - 0.05) {
      const end = clipEnd;
      clipEnd = null;
      pause();
      audio.currentTime = end;
    }
    setCurrent(lineAt(audio.currentTime));
    if (!seeking) $("#seek").value = Math.floor(audio.currentTime);
    $("#t-cur").textContent = fmtTime(audio.currentTime);
    throttledPosition();
  });
  audio.addEventListener("loadedmetadata", () => {
    if (isFinite(audio.duration)) { $("#seek").max = Math.floor(audio.duration); $("#t-dur").textContent = fmtTime(audio.duration); }
    updatePosition();
  });
  const syncPlay = () => {
    const playing = !audio.paused;
    $("#play-icon").setAttribute("href", playing ? "#i-pause" : "#i-play");
    $("#play-label").textContent = playing ? "Pausa" : "Play";
    $("#btn-play").setAttribute("aria-label", playing ? "Pausa" : "Reproducir");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    updatePosition();
  };
  audio.addEventListener("play", syncPlay);
  audio.addEventListener("pause", syncPlay);
  audio.addEventListener("ratechange", updatePosition);
  audio.addEventListener("error", () => toast("No se pudo cargar el audio de NRK"));
  let seeking = false;

  // ---------- Media Session (car / Bluetooth / lock screen) ----------
  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const art = [ep.image, ep.showImage].filter(Boolean).map((src) => ({ src, sizes: "1400x1400", type: "image/png" }));
    navigator.mediaSession.metadata = new MediaMetadata({ title: ep.title, artist: ep.show + " · " + ep.host, album: "NRK · Norwegian Study Buddy", artwork: art });
    const h = {
      play: () => play(),
      pause: () => pause(),
      stop: () => pause(),
      seekbackward: (d) => skip(-(d.seekOffset || 10)),
      seekforward: (d) => skip(d.seekOffset || 10),
      previoustrack: () => { if (!$("#meaning").hidden) return review.active ? review.go(-1) : null; lineStep(-1); },
      nexttrack: () => { if (!$("#meaning").hidden) return review.active ? review.go(1) : null; lineStep(1); },
      seekto: (d) => { if (d.fastSeek && "fastSeek" in audio) audio.fastSeek(d.seekTime); else seek(d.seekTime); },
    };
    for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch (e) { /* unsupported action */ } }
  }
  let posT = 0;
  function throttledPosition() { const now = Date.now(); if (now - posT > 1000) { posT = now; updatePosition(); } }
  function updatePosition() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    const duration = isFinite(audio.duration) ? audio.duration : ep.durationSec;
    if (!duration) return;
    try { navigator.mediaSession.setPositionState({ duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime || 0, duration) }); } catch (e) {}
  }

  // ---------- Spanish speech (Web Speech API) ----------
  // Tesla / older Chromium often has empty getVoices() at start, and drops
  // speak() if it runs in the same tick as cancel(). Keep a live utterance
  // reference so it is not garbage-collected before onend.
  let voice = null;
  let currentUtterance = null;
  let speakTimer = 0;
  function voicesList() {
    try { return (speechSynthesis.getVoices && speechSynthesis.getVoices()) || []; }
    catch (e) { return []; }
  }
  function chooseVoice(vs) {
    vs = vs || [];
    return (prefs.voiceURI && vs.find((v) => v.voiceURI === prefs.voiceURI))
      || vs.find((v) => /^es[-_]ES/i.test(v.lang))
      || vs.find((v) => /^es/i.test(v.lang))
      || null;
  }
  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    const vs = voicesList();
    voice = chooseVoice(vs);
    fillVoices(vs);
    if ($("#settings") && !$("#settings").hidden) renderTtsDiag();
  }
  function fillVoices(vs) {
    const sel = $("#more-voice");
    if (!sel) return;
    const list = (vs || []).filter((v) => /^es/i.test(v.lang));
    const cur = prefs.voiceURI || "";
    sel.replaceChildren(el("option", { value: "" }, "Automática (es-ES)"));
    for (const v of list) sel.append(el("option", { value: v.voiceURI }, v.name + " (" + v.lang + ")"));
    if (cur && !list.some((v) => v.voiceURI === cur)) sel.append(el("option", { value: cur }, "Voz guardada"));
    sel.value = cur;
  }
  if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.addEventListener?.("voiceschanged", pickVoice); }

  function applyRate() {
    const r = Number(prefs.rate) || 1;
    audio.playbackRate = r;
    $$("#speed [data-rate]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === r)));
  }

  function waitForVoices() {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve([]);
      const have = voicesList();
      if (have.length) return resolve(have);
      let done = false;
      const finish = () => { if (done) return; done = true; speechSynthesis.removeEventListener?.("voiceschanged", finish); resolve(voicesList()); };
      speechSynthesis.addEventListener?.("voiceschanged", finish);
      setTimeout(finish, 800);
    });
  }

  function esClipUrl(lineIndex) {
    if (lineIndex == null || lineIndex < 0 || lineIndex !== lineIndex) return "";
    return "episodes/" + slug + "/es/" + lineIndex + ".mp3?v=" + ES_AUDIO_V;
  }
  function lineIndexForText(text) {
    const clean = String(text || "").trim();
    if (!clean) return null;
    const hit = lines.findIndex((l) => String(l.es || "").trim() === clean);
    return hit >= 0 ? (lines[hit].idx != null ? lines[hit].idx : hit) : null;
  }
  let esAudioFinish = null;
  function stopEsAudio() {
    if (esAudioFinish) { const f = esAudioFinish; esAudioFinish = null; f(false); }
    if (!esAudio) return;
    try { esAudio.pause(); } catch (e) {}
    try { esAudio.removeAttribute("src"); esAudio.load(); } catch (e) {}
  }
  function playEsClip(url, { resume = true } = {}) {
    return new Promise((resolve) => {
      if (!esAudio || !url) return resolve(false);
      const wasPlaying = !audio.paused;
      pause();
      stopEsAudio();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        esAudioFinish = null;
        esAudio.removeEventListener("ended", onEnded);
        esAudio.removeEventListener("error", onError);
        if (resume && wasPlaying && ok) play();
        else if (resume && wasPlaying && !ok) play();
        resolve(!!ok);
      };
      const onEnded = () => finish(true);
      const onError = () => finish(false);
      esAudioFinish = finish;
      esAudio.muted = false;
      if (!(esAudio.volume > 0)) esAudio.volume = 1;
      esAudio.addEventListener("ended", onEnded);
      esAudio.addEventListener("error", onError);
      esAudio.src = url;
      try { esAudio.load(); } catch (e) {}
      const req = esAudio.play();
      if (req && req.catch) {
        req.catch((e) => {
          if (e && e.name === "AbortError") return;
          finish(false);
        });
      }
    });
  }
  function speakEsSynth(text, { resume = true } = {}) {
    return new Promise((resolve) => {
      const clean = String(text || "").replace(/\[[^\]]*\]/g, "").trim();
      if (!clean || !("speechSynthesis" in window)) return resolve(false);
      const wasPlaying = !audio.paused;
      pause();
      let done = false;
      let guard = 0;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        clearTimeout(speakTimer);
        if (resume && wasPlaying) play();
        resolve(!!ok);
      };
      const start = (vs) => {
        if (done) return;
        try { speechSynthesis.cancel(); } catch (e) {}
        const u = new SpeechSynthesisUtterance(clean);
        currentUtterance = u;
        u.lang = "es-ES";
        u.rate = 0.95;
        u.volume = 1;
        u.pitch = 1;
        const v = chooseVoice(vs);
        if (v) u.voice = v;
        u.onend = () => finish(true);
        u.onerror = () => finish(true);
        guard = setTimeout(() => finish(true), 4000 + clean.length * 120);
        clearTimeout(speakTimer);
        speakTimer = setTimeout(() => {
          try { speechSynthesis.speak(u); }
          catch (e) { finish(true); return; }
          setTimeout(() => {
            if (done) return;
            try {
              if (!speechSynthesis.speaking && !speechSynthesis.pending) finish(true);
            } catch (e) { finish(true); }
          }, 180);
        }, 60);
      };
      waitForVoices().then(start);
    });
  }
  function speakEs(text, { resume = true, lineIndex = null, allowSynth = true } = {}) {
    const clean = String(text || "").replace(/\[[^\]]*\]/g, "").trim();
    if (!clean) return Promise.resolve(false);
    let idx = lineIndex;
    if (idx == null || idx < 0) idx = lineIndexForText(clean);
    const url = esClipUrl(idx);
    if (url) {
      return playEsClip(url, { resume }).then((ok) => {
        if (ok) return true;
        if (!allowSynth) return false;
        return speakEsSynth(clean, { resume });
      });
    }
    if (!allowSynth) return Promise.resolve(false);
    return speakEsSynth(clean, { resume });
  }
  const stopSpeech = () => {
    clearTimeout(speakTimer);
    stopEsAudio();
    if ("speechSynthesis" in window) try { speechSynthesis.cancel(); } catch (e) {}
  };

  // ---------- vocabulary matching ----------
  function vocabKeys(no) {
    return no.replace(/\([^)]*\)/g, "").split(/[,/]/).map((p) => p.replace(/\.\.\.|…/g, "").trim().toLowerCase()).filter(Boolean)
      .map((p) => p.split(/\s+/).map((w) => (w.length <= 3 ? { w, exact: true } : { w: w.slice(0, Math.max(4, w.length - 3)), exact: false })));
  }
  function vocabIn(text) {
    const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
    const hit = (k) => words.some((w) => (k.exact ? w === k.w : w.startsWith(k.w)));
    return vocab.filter((v) => v.keys.some((phrase) => phrase.every(hit)));
  }

  // ---------- "No entendí" / "Esto significa" ----------
  // A mark is added only by an explicit press of «No entendí» (or the N key),
  // at most once per line. Review, replay, Continuar and Ya entiendo never add marks.
  // Root cause of the old bug: every press called store.add() with a new id, and
  // the time was currentTime-2, which often tagged the previous line; N also
  // kept working while the card was already open, creating more duplicates.
  const AUTO_CONTINUE_SEC = 8;
  const lineInfo = (l) => (l ? { no: l.text, es: l.es || "", lineIndex: l.idx } : null);
  let meaning = { item: null, wasPlaying: false, resumeAt: 0, token: 0 };
  let clipEnd = null;
  let autoContinueTimer = 0;
  let autoContinueLeft = 0;
  let autoContinueCancelled = false;

  function markDoubt() {
    if (!$("#meaning").hidden) return;
    stopSpeech();
    cancelAutoContinue();
    const wasPlaying = !audio.paused;
    const resumeAt = audio.currentTime || 0;
    const i = lineAt(resumeAt);
    const l = lines[i];
    if (!l) return;
    let item = dudas().find((d) => d.lineIndex === i);
    if (!item) {
      item = {
        kind: "duda", id: "d-" + Date.now().toString(36), ep: slug,
        t: l.start, lineIndex: i, no: l.text, es: l.es || "",
        context: { prev: lineInfo(lines[i - 1]), next: lineInfo(lines[i + 1]) },
        vocab: vocabIn(l.text).map((v) => ({ no: v.no, es: v.es })),
        created: new Date().toISOString(),
      };
      const note = store.add({ segmentId: l.seg.id, start: l.start, type: "highlight", text: JSON.stringify(item) });
      item.noteId = note.id;
    }
    if (navigator.vibrate) navigator.vibrate(60);
    pause();
    showMeaning(item, { wasPlaying, resumeAt });
  }

  function setGoLabel(text) {
    const n = $("#m-go-label");
    if (n) n.textContent = text;
  }

  function cancelAutoContinue() {
    autoContinueCancelled = true;
    if (autoContinueTimer) { clearInterval(autoContinueTimer); autoContinueTimer = 0; }
    autoContinueLeft = 0;
    if (!$("#meaning").hidden) setGoLabel("Continuar");
  }

  function startAutoContinue(token) {
    if (autoContinueCancelled || $("#meaning").hidden || token !== meaning.token) return;
    autoContinueLeft = AUTO_CONTINUE_SEC;
    setGoLabel("Continuar · " + autoContinueLeft);
    autoContinueTimer = setInterval(() => {
      if (autoContinueCancelled || $("#meaning").hidden || token !== meaning.token) {
        cancelAutoContinue();
        return;
      }
      autoContinueLeft -= 1;
      if (autoContinueLeft <= 0) {
        cancelAutoContinue();
        continueMeaning();
        return;
      }
      setGoLabel("Continuar · " + autoContinueLeft);
    }, 1000);
  }

  function fillContextLine(node, line) {
    if (!node) return;
    if (!line || !line.no) {
      node.hidden = true;
      node.replaceChildren();
      return;
    }
    node.hidden = false;
    const noEl = el("div", { class: "ctx-no", lang: "nb" });
    linkWords(noEl, line.no, line);
    const esEl = el("div", { class: "ctx-es", lang: "es" }, line.es || "");
    node.replaceChildren(noEl, esEl);
  }

  function showMeaning(item, opts = {}) {
    const wasPlaying = !!(opts.wasPlaying);
    const resumeAt = opts.resumeAt != null ? opts.resumeAt : (audio.currentTime || 0);
    meaning = { item, wasPlaying, resumeAt, token: meaning.token + 1 };
    const token = meaning.token;
    autoContinueCancelled = false;
    if (autoContinueTimer) { clearInterval(autoContinueTimer); autoContinueTimer = 0; }
    setGoLabel("Continuar");
    closeWordHint();
    $("#m-es").textContent = item.es || "(sin traducción)";
    linkWords($("#m-no"), item.no, { no: item.no, es: item.es || "", lineIndex: item.lineIndex });
    const hits = item.vocab && item.vocab.length ? item.vocab : vocabIn(item.no).map((v) => ({ no: v.no, es: v.es }));
    $("#m-vocab").replaceChildren(...hits.map((v) => el("div", null, el("b", { lang: "nb" }, v.no), " = ", v.es)));
    const c = item.context || {};
    fillContextLine($("#m-prev"), c.prev);
    fillContextLine($("#m-next"), c.next);
    const inReview = review.active;
    $("#m-count").hidden = !inReview;
    if (inReview) $("#m-count").textContent = "Duda " + (review.i + 1) + " de " + review.items.length;
    $("#m-kicker").textContent = inReview ? "Repaso" : "Esto significa:";
    $("#meaning").hidden = false;
    $("#m-go").focus({ preventScroll: true });
    stopClip();
    speakEs(item.es, { resume: false, lineIndex: item.lineIndex != null ? item.lineIndex : lineIndexForText(item.es) }).then(() => {
      if (token !== meaning.token || $("#meaning").hidden) return;
      startAutoContinue(token);
    });
  }

  function stopClip() { clipEnd = null; }

  function closeMeaningCard() {
    closeWordHint();
    stopSpeech();
    cancelAutoContinue();
    stopClip();
    $("#meaning").hidden = true;
  }

  function continueMeaning() {
    const state = meaning;
    const inReview = review.active;
    closeMeaningCard();
    if (inReview) {
      review.items = dudas();
      if (state._removed) { /* stay on the same index: the next item slid into it */ }
      else review.i += 1;
      if (review.i < review.items.length) review.showCurrent();
      else review.stop();
      return;
    }
    const t = state.resumeAt || 0;
    seek(t);
    if (state.wasPlaying) play();
  }

  function gotIt() {
    cancelAutoContinue();
    const item = meaning.item;
    const id = item && item.noteId;
    if (id) store.remove(id);
    meaning._removed = true;
    continueMeaning();
  }

  function replaySpanish() {
    cancelAutoContinue();
    const item = meaning.item;
    if (item && item.es) speakEs(item.es, { resume: false, lineIndex: item.lineIndex != null ? item.lineIndex : lineIndexForText(item.es) });
  }

  function replayNorwegian() {
    cancelAutoContinue();
    stopSpeech();
    const item = meaning.item;
    if (!item) return;
    const l = (item.lineIndex != null && lines[item.lineIndex]) || lines[lineAt(item.t)] || null;
    if (!l) return;
    const start = l.start;
    const end = (l.end != null && l.end > start) ? l.end : (lines[l.idx + 1] ? lines[l.idx + 1].start : (isFinite(audio.duration) ? audio.duration : start + 8));
    clipEnd = end;
    seek(start);
    play();
  }


  // ---------- word hint (only on the «Esto significa» / review card) ----------
  const POS_ES = { VERB: "verbo", NOUN: "sustantivo", ADJ: "adjetivo", ADV: "adverbio", PREP: "preposición", PRON: "pronombre", DET: "determinante", CONJ: "conjunción", INTJ: "interjección" };
  let wordHintToken = 0;

  function normalizeWord(w) {
    return String(w || "").replace(/^[«»“”"'‘’(\[]+|[»“”"'‘’)\],.:;!?…]+$/g, "").trim();
  }

  function splitWords(text) {
    const s = String(text || "");
    try { return s.split(/([^\p{L}\p{N}-]+)/u); }
    catch (e) { return s.split(/([^A-Za-zÀ-ÖØ-öø-ÿ0-9-]+)/); }
  }

  function linkWords(root, text, lineCtx) {
    if (!root) return;
    root.replaceChildren();
    const parts = splitWords(text);
    for (const part of parts) {
      const isWord = (function () {
        try { return /[\p{L}]/u.test(part); }
        catch (e) { return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(part); }
      })();
      if (isWord) {
        const b = el("button", { type: "button", class: "word", "data-word": part }, part);
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openWordHint(part, lineCtx);
        });
        root.append(b);
      } else if (part) root.append(part);
    }
  }

  function vocabForWord(word) {
    const w = normalizeWord(word).toLowerCase();
    if (!w) return null;
    const exact = [];
    const soft = [];
    for (const v of vocab) {
      const tokens = splitWords(String(v.no || "")).map((tok) => tok.toLowerCase()).filter((tok) => {
        try { return /[\p{L}\p{N}]/u.test(tok); }
        catch (e) { return /[A-Za-zÀ-ÖØ-öø-ÿ0-9]/.test(tok); }
      });
      if (tokens.includes(w)) { exact.push(v); continue; }
      if (v.keys && v.keys.some((phrase) => phrase.some((k) => (k.exact ? w === k.w : w.startsWith(k.w) || k.w.startsWith(w))))) {
        soft.push(v);
      }
    }
    return exact[0] || soft[0] || null;
  }

  function firstExplanation(node) {
    if (!node) return "";
    if (Array.isArray(node)) {
      for (const n of node) { const t = firstExplanation(n); if (t) return t; }
      return "";
    }
    if (typeof node !== "object") return "";
    if (node.type_ === "explanation" || (node.content && !node.elements)) {
      let c = String(node.content || "");
      const items = node.items || [];
      let i = 0;
      c = c.replace(/\$/g, () => {
        const it = items[i++];
        if (!it) return "";
        if (it.text) return it.text;
        if (it.lemmas && it.lemmas[0] && it.lemmas[0].lemma) return it.lemmas[0].lemma;
        return "";
      });
      c = c.replace(/\s+/g, " ").trim();
      return c;
    }
    if (node.definitions) return firstExplanation(node.definitions);
    if (node.elements) return firstExplanation(node.elements);
    if (node.body) return firstExplanation(node.body);
    return "";
  }

  function parseArticle(art) {
    if (!art) return null;
    const lemma = (art.lemmas && art.lemmas[0] && art.lemmas[0].lemma) || "";
    const para = art.lemmas && art.lemmas[0] && (art.lemmas[0].paradigm_info || [])[0];
    const tags = (para && para.tags) || [];
    const main = tags.find((t) => POS_ES[t]) || tags[0] || "";
    let pos = POS_ES[main] || (main ? main.toLowerCase() : "");
    if (main === "NOUN") {
      if (tags.includes("Masc")) pos += " (m.)";
      else if (tags.includes("Fem")) pos += " (f.)";
    }
    const def = firstExplanation(art.body);
    return { lemma, pos, def };
  }

  async function lookupOrd(word) {
    const n = normalizeWord(word);
    const tries = [];
    if (n) tries.push(n);
    const lower = n.toLowerCase();
    if (lower && lower !== n) tries.push(lower);
    const seen = new Set();
    for (const w of tries) {
      if (seen.has(w)) continue;
      seen.add(w);
      try {
        const res = await fetch("https://ord.uib.no/api/articles?w=" + encodeURIComponent(w) + "&dict=bm&scope=ei");
        if (!res.ok) continue;
        const data = await res.json();
        const ids = (data.articles && data.articles.bm) || [];
        if (!ids.length) continue;
        const artRes = await fetch("https://ord.uib.no/bm/article/" + ids[0] + ".json");
        if (!artRes.ok) continue;
        return parseArticle(await artRes.json());
      } catch (e) { /* network or CORS */ }
    }
    return null;
  }

  function closeWordHint() {
    wordHintToken += 1;
    const box = $("#word-hint");
    if (box) box.hidden = true;
    const speakBtn = $("#wh-speak");
    if (speakBtn) speakBtn.dataset.es = "";
  }

  function openWordHint(word, lineCtx) {
    cancelAutoContinue();
    const token = ++wordHintToken;
    const raw = normalizeWord(word) || word;
    const box = $("#word-hint");
    if (!box) return;
    $("#wh-word").textContent = raw;
    $("#wh-class").hidden = true;
    $("#wh-class").textContent = "";
    $("#wh-es").textContent = "";
    $("#wh-def").textContent = "";
    $("#wh-ctx").hidden = true;
    $("#wh-ctx").textContent = "";
    const v = vocabForWord(raw);
    const vocabEs = (v && v.es) || "";
    const lineEs = (lineCtx && lineCtx.es) || "";
    const es = vocabEs || lineEs;
    if (es) $("#wh-es").textContent = es;
    else $("#wh-es").textContent = "Buscando…";
    if (lineEs && vocabEs && lineEs !== vocabEs) {
      $("#wh-ctx").hidden = false;
      $("#wh-ctx").textContent = lineEs;
    }
    const clipIdx = (lineEs && es === lineEs && lineCtx && lineCtx.lineIndex != null)
      ? lineCtx.lineIndex
      : lineIndexForText(es);
    const hasClip = clipIdx != null && clipIdx >= 0;
    const hasVoice = !!chooseVoice(voicesList());
    $("#wh-speak").hidden = !(es && (hasClip || hasVoice));
    $("#wh-speak").dataset.es = es;
    $("#wh-speak").dataset.lineIndex = hasClip ? String(clipIdx) : "";
    $("#wh-ordbok").href = "https://ordbokene.no/nob/bm/" + encodeURIComponent(raw.toLowerCase());
    box.hidden = false;
    $("#wh-close").focus({ preventScroll: true });
    lookupOrd(raw).then((api) => {
      if (token !== wordHintToken) return;
      if (api && api.lemma && api.lemma.toLowerCase() !== raw.toLowerCase()) {
        $("#wh-word").textContent = raw + " · " + api.lemma;
        $("#wh-ordbok").href = "https://ordbokene.no/nob/bm/" + encodeURIComponent(api.lemma.toLowerCase());
      }
      if (api && api.pos) { $("#wh-class").hidden = false; $("#wh-class").textContent = api.pos; }
      if (api && api.def) $("#wh-def").textContent = api.def;
      if (!es) {
        // No Spanish from vocab or line context: show the Norwegian definition.
        $("#wh-es").textContent = "";
        $("#wh-speak").hidden = true;
        $("#wh-speak").dataset.es = "";
        if (!(api && api.def)) $("#wh-es").textContent = "Sin resultados";
      }
    });
  }

  // ---------- collection ("Mis dudas") ----------
  function dudas() {
    if (!store) return [];
    const out = [];
    for (const n of store.notes) {
      if (n.type !== "highlight") continue;
      try {
        const it = JSON.parse(n.text);
        if (it && it.kind === "duda") out.push({ ...it, noteId: n.id, pending: !!n._pending });
      } catch (e) { /* not a duda */ }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  function onStoreChange() {
    const list = dudas();
    $("#dudas-count").textContent = list.length;
    $("#sync-dot").dataset.state = store.cloudOk ? store.state : "local";
    const marked = new Set(list.map((d) => d.lineIndex));
    lines.forEach((l) => l.node.classList.toggle("marked", marked.has(l.idx)));
    if (!$("#panel").hidden) renderDudas();
    if (!$("#settings").hidden) renderStatus();
  }

  function renderDudas() {
    const list = dudas();
    $("#btn-review").disabled = !list.length;
    $("#btn-review").style.opacity = list.length ? 1 : 0.4;
    if (!list.length) {
      $("#dudas-list").replaceChildren(el("div", { class: "empty" }, "Todavía no hay dudas. Pulsa «No entendí» mientras escuchas."));
      return;
    }
    $("#dudas-list").replaceChildren(...list.map((d) => {
      const c = d.context || {};
      return el("div", { class: "item" + (d.pending && store.cloudOk ? " syncing" : "") },
        el("button", { class: "main", type: "button", onclick: () => { closePanel(); pause(); showMeaning(d, { wasPlaying: false, resumeAt: audio.currentTime || 0 }); } },
          el("span", { class: "when" }, svgUse("#i-play"), " " + fmtTime(d.t)),
          el("span", { class: "no", lang: "nb" }, d.no),
          el("span", { class: "es" }, d.es),
          (c.prev || c.next) && el("span", { class: "cx", lang: "nb" }, [c.prev && "… " + c.prev.no, c.next && c.next.no + " …"].filter(Boolean).join("  /  "))),
        el("button", { class: "del", type: "button", "aria-label": "Borrar duda", onclick: () => {
          if (confirm("¿Borrar esta duda?")) { store.remove(d.noteId); toast("Duda borrada"); }
        } }, svgUse("#i-trash")));
    }));
  }
  function svgUse(id) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", id); s.append(u); return s;
  }

  function renderVocab() {
    $("#vocab-list").replaceChildren(...vocab.map((v) => {
      const seg = ep.segments.find((s) => s.id === v.segmentId);
      return el("div", { class: "item" }, el("div", { class: "main" },
        el("span", { class: "no", lang: "nb" }, v.no),
        el("span", { class: "es" }, v.es || v.en),
        v.note && el("span", { class: "cx", lang: "nb" }, v.note),
        seg && el("button", { class: "tab", type: "button", style: "justify-self:start;margin-top:4px", onclick: () => { closePanel(); seek(seg.start); } }, svgUse("#i-play"), " " + fmtTime(seg.start))));
    }));
  }

  let notesLoaded = false;
  async function loadStudyNotes() {
    if (notesLoaded) return;
    notesLoaded = true;
    try {
      const res = await fetch("episodes/" + slug + "/study-notes.md");
      if (!res.ok) throw new Error(res.status);
      const md = await res.text();
      const box = $("#study-notes");
      box.innerHTML = window.marked ? window.marked.parse(md) : "";
      if (!window.marked) box.textContent = md;
      box.prepend(el("p", { class: "hint" }, "Apuntes de estudio (en inglés)."));
      $$("a", box).forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
    } catch (e) {
      $("#study-notes").textContent = "No hay apuntes para este episodio.";
    }
  }

  function openPanel(tab = "dudas") {
    $("#panel").hidden = false;
    selectTab(tab);
  }
  function closePanel() { $("#panel").hidden = true; }
  function selectTab(tab) {
    $$(".tab[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $$("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
    $("#panel").scrollTop = 0;
    $("#panel-title").textContent = { dudas: "Mis dudas", vocab: "Vocabulario", notes: "Apuntes" }[tab];
    if (tab === "dudas") renderDudas();
    if (tab === "notes") loadStudyNotes();
  }

  // ---------- review mode ("Repasar todo") — same card as «No entendí» ----------
  const review = {
    active: false, i: 0, items: [],
    start() {
      this.items = dudas();
      if (!this.items.length) return;
      this.active = true; this.i = 0;
      closePanel();
      this.showCurrent();
    },
    showCurrent() {
      const d = this.items[this.i];
      if (!d) { this.stop(); return; }
      pause();
      showMeaning(d, { wasPlaying: false, resumeAt: audio.currentTime || 0 });
    },
    go(dir) {
      if (!this.active) return;
      cancelAutoContinue();
      this.items = dudas();
      this.i = Math.max(0, Math.min(this.items.length - 1, this.i + dir));
      this.showCurrent();
    },
    stop() {
      this.active = false;
      closeMeaningCard();
      pause();
    },
  };

  // ---------- settings ----------
  function statusText() {
    if (store && store.cloudOk && store.state === "saving") return "Guardando…";
    if (store && store.cloudOk && store.state === "pending") return "Guardando…";
    if (store && store.cloudOk) return "Guardado.";
    return "Tus dudas se guardan en este dispositivo.";
  }
  function renderStatus() {
    const box = $("#s-status");
    box.textContent = statusText();
    box.classList.remove("warn", "err");
  }
  function closeSettings() { $("#settings").hidden = true; }
  function closeMore() { $("#more").hidden = true; }
  function openMore() { $("#more").hidden = false; applyRate(); pickVoice(); }
  function openSettings(msg) {
    closeMore();
    $("#settings").hidden = false;
    $("#s-pass").value = "";
    $("#s-pass").placeholder = NSB.passphrase.get() ? "•••••• (guardada)" : "Solo para guardar en la nube";
    $("#s-follow").checked = prefs.follow;
    $("#s-about").textContent = msg || "";
    renderStatus();
    renderTtsDiag();
  }
  function renderTtsDiag() {
    const box = $("#s-tts");
    if (!box) return;
    const supported = "speechSynthesis" in window;
    const vs = supported ? voicesList() : [];
    const es = vs.filter((v) => /^es/i.test(v.lang || ""));
    box.textContent = "Síntesis del navegador: " + (supported ? "sí" : "no")
      + " · voces: " + vs.length
      + (es.length ? " · español: " + es.length : " · sin voz en español");
  }
  function testEsVoice() {
    const l = lines[1] || lines[0];
    if (!l) return;
    speakEs(l.es, { resume: true, lineIndex: l.idx });
  }
  function dismissOnBackdrop(overlay, closeFn) {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeFn(); });
  }

  let topHideTimer = 0;
  const TOP_SLIDE_MS = 300;
  function applyTop() {
    const topEl = $("#top");
    const slot = $("#top-slot");
    const un = $("#btn-unhide");
    const hide = !!prefs.hideTop;
    const root = document.documentElement;
    if (un) {
      un.setAttribute("aria-hidden", hide ? "false" : "true");
      un.tabIndex = hide ? 0 : -1;
    }
    if (!topEl) {
      root.classList.toggle("top-hidden", hide);
      root.classList.toggle("top-hidden-done", hide);
      return;
    }
    clearTimeout(topHideTimer);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (hide) {
      root.classList.remove("top-hidden-done");
      const h = (slot && (slot.offsetHeight || topEl.offsetHeight)) || topEl.offsetHeight;
      if (slot) slot.style.height = h + "px";
      void (slot || topEl).offsetHeight;
      root.classList.add("top-hidden");
      if (slot) slot.style.height = "0px";
      const finish = () => {
        if (!prefs.hideTop) return;
        root.classList.add("top-hidden-done");
        if (slot) slot.style.height = "";
      };
      if (reduce) finish();
      else topHideTimer = setTimeout(finish, TOP_SLIDE_MS + 50);
    } else {
      const startHidden = root.classList.contains("top-hidden-done") || (slot && getComputedStyle(slot).display === "none") || getComputedStyle(topEl).display === "none";
      root.classList.remove("top-hidden-done");
      if (startHidden) {
        root.classList.add("top-hidden");
        if (slot) slot.style.height = "0px";
        void topEl.offsetHeight;
      }
      const h = topEl.offsetHeight;
      if (reduce) {
        root.classList.remove("top-hidden");
        if (slot) slot.style.height = "";
      } else {
        requestAnimationFrame(() => {
          root.classList.remove("top-hidden");
          if (slot) slot.style.height = h + "px";
          topHideTimer = setTimeout(() => { if (!prefs.hideTop && slot) slot.style.height = ""; }, TOP_SLIDE_MS + 50);
        });
      }
    }
  }

  function applyEs() {
    document.body.classList.toggle("no-es", !prefs.es);
    $("#btn-es").setAttribute("aria-pressed", String(prefs.es));
    $("#btn-es").textContent = prefs.es ? "ES visible" : "ES oculto";
  }

  // ---------- wiring ----------
  function holdable(btn, onTap, onHold) {
    let timer, held = false;
    btn.addEventListener("pointerdown", () => { held = false; clearTimeout(timer); timer = setTimeout(() => { held = true; onHold(); if (navigator.vibrate) navigator.vibrate(30); }, 550); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, () => clearTimeout(timer)));
    btn.addEventListener("click", (e) => { if (held) { e.preventDefault(); held = false; return; } onTap(); });
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  function wire() {
    $("#btn-play").addEventListener("click", toggle);
    $("#btn-back").addEventListener("click", () => skip(-10));
    $("#btn-fwd").addEventListener("click", () => skip(10));
    $("#btn-prev").addEventListener("click", () => lineStep(-1));
    $("#btn-next").addEventListener("click", () => lineStep(1));
    $("#btn-doubt").addEventListener("click", markDoubt);
    $("#btn-speak").addEventListener("click", () => { const l = lines[lineAt(audio.currentTime)]; if (l) speakEs(l.es, { lineIndex: l.idx }); });
    $("#btn-es").addEventListener("click", () => { prefs.es = !prefs.es; savePrefs(); applyEs(); });
    $$("#speed [data-rate]").forEach((b) => b.addEventListener("click", () => {
      prefs.rate = Number(b.dataset.rate) || 1; savePrefs(); applyRate();
    }));
    $("#more-voice").addEventListener("change", (e) => {
      prefs.voiceURI = e.target.value; savePrefs(); pickVoice();
    });
    const s = $("#seek");
    s.addEventListener("input", () => { seeking = true; $("#t-cur").textContent = fmtTime(+s.value); });
    s.addEventListener("change", () => { seeking = false; seek(+s.value); });

    $("#m-go").addEventListener("click", continueMeaning);
    $("#m-gotit").addEventListener("click", gotIt);
    $("#m-btn-es").addEventListener("click", replaySpanish);
    $("#m-btn-no").addEventListener("click", replayNorwegian);
    $("#m-close").addEventListener("click", continueMeaning);
    $("#meaning").addEventListener("pointerdown", cancelAutoContinue);
    $("#wh-close").addEventListener("click", closeWordHint);
    $("#wh-speak").addEventListener("click", () => {
      const es = $("#wh-speak").dataset.es || "";
      const rawIdx = $("#wh-speak").dataset.lineIndex;
      const idx = rawIdx === "" || rawIdx == null ? null : Number(rawIdx);
      if (es) speakEs(es, { resume: false, lineIndex: idx, allowSynth: !!chooseVoice(voicesList()) });
    });
    dismissOnBackdrop($("#word-hint"), closeWordHint);

    $("#btn-dudas").addEventListener("click", () => openPanel("dudas"));
    $("#panel-close").addEventListener("click", closePanel);
    $("#panel-close-2").addEventListener("click", closePanel);
    $$(".tab[data-tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
    $("#btn-review").addEventListener("click", () => review.start());

    $("#btn-more").addEventListener("click", openMore);
    $("#more-close").addEventListener("click", closeMore);
    $("#btn-settings").addEventListener("click", () => openSettings());
    $("#settings-close").addEventListener("click", closeSettings);
    $("#settings-close-2").addEventListener("click", closeSettings);
    dismissOnBackdrop($("#more"), closeMore);
    dismissOnBackdrop($("#settings"), closeSettings);
    dismissOnBackdrop($("#panel"), closePanel);
    dismissOnBackdrop($("#meaning"), continueMeaning);
    $("#s-save").addEventListener("click", () => {
      const v = $("#s-pass").value.trim();
      if (v) {
        NSB.passphrase.set(v);
        store.rejectedPass = null;
        store.flush();
      }
      $("#s-pass").value = "";
      $("#s-pass").placeholder = NSB.passphrase.get() ? "•••••• (guardada)" : "Solo para guardar en la nube";
      renderStatus();
    });
    $("#s-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#s-save").click(); });
    $("#s-forget").addEventListener("click", () => {
      NSB.passphrase.forget();
      store.rejectedPass = null;
      store.cloudOk = false;
      store.setState("local");
      openSettings();
    });
    $("#s-follow").addEventListener("change", (e) => { prefs.follow = e.target.checked; savePrefs(); });
    if ($("#s-test-es")) $("#s-test-es").addEventListener("click", testEsVoice);
    $("#btn-hide-top").addEventListener("click", () => { prefs.hideTop = true; savePrefs(); applyTop(); });
    $("#btn-unhide").addEventListener("click", () => { prefs.hideTop = false; savePrefs(); applyTop(); });
    $("#s-export").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ ep: slug, exported: new Date().toISOString(), dudas: dudas() }, null, 2)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: "mis-dudas-" + slug + ".json" });
      document.body.append(a); a.click(); a.remove();
    });

    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input,textarea,select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if ($("#word-hint") && !$("#word-hint").hidden) return closeWordHint();
        if (!$("#meaning").hidden) {
          if (review.active) return review.stop();
          return continueMeaning();
        }
        if (!$("#settings").hidden) return closeSettings();
        if (!$("#more").hidden) return closeMore();
        $("#panel").hidden = true; return;
      }
      if (!$("#meaning").hidden) return;
      const k = e.key.toLowerCase();
      const map = {
        " ": toggle, k: toggle, arrowleft: () => skip(-10), arrowright: () => skip(10), j: () => skip(-10), l: null,
        arrowup: () => lineStep(-1), arrowdown: () => lineStep(1), n: markDoubt,
        e: () => $("#btn-es").click(), d: () => ($("#panel").hidden ? openPanel("dudas") : closePanel()),
      };
      map.l = () => $("#btn-speak").click();
      if (map[k]) {
        if (e.target.closest("button") && (k === " " || k === "enter")) e.preventDefault();
        e.preventDefault();
        map[k]();
      }
    });
  }
})();
