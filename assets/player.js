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
    audio.src = ep.audioUrl;
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
  const play = () => audio.play().catch((e) => { if (e.name !== "AbortError") toast("No se pudo reproducir el audio"); });
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
  let voice = null;
  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    const vs = speechSynthesis.getVoices();
    voice = (prefs.voiceURI && vs.find((v) => v.voiceURI === prefs.voiceURI))
      || vs.find((v) => /^es[-_]ES/i.test(v.lang))
      || vs.find((v) => /^es/i.test(v.lang))
      || null;
    fillVoices(vs);
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

  function speakEs(text, { resume = true } = {}) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window) || !text) { if (text) toast("Este navegador no puede leer en voz alta"); return resolve(false); }
      const wasPlaying = !audio.paused;
      pause();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/\[[^\]]*\]/g, ""));
      u.lang = "es-ES";
      if (voice) u.voice = voice;
      u.rate = 0.95;
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(guard); if (resume && wasPlaying) play(); resolve(true); };
      u.onend = finish; u.onerror = finish;
      const guard = setTimeout(finish, 4000 + text.length * 120); // some engines never fire onend
      speechSynthesis.speak(u);
    });
  }
  const stopSpeech = () => { if ("speechSynthesis" in window) speechSynthesis.cancel(); };

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
  const lineInfo = (l) => (l ? { no: l.text, es: l.es || "" } : null);
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

  function showMeaning(item, opts = {}) {
    const wasPlaying = !!(opts.wasPlaying);
    const resumeAt = opts.resumeAt != null ? opts.resumeAt : (audio.currentTime || 0);
    meaning = { item, wasPlaying, resumeAt, token: meaning.token + 1 };
    const token = meaning.token;
    autoContinueCancelled = false;
    if (autoContinueTimer) { clearInterval(autoContinueTimer); autoContinueTimer = 0; }
    setGoLabel("Continuar");
    $("#m-es").textContent = item.es || "(sin traducción)";
    $("#m-no").textContent = item.no;
    const hits = item.vocab && item.vocab.length ? item.vocab : vocabIn(item.no).map((v) => ({ no: v.no, es: v.es }));
    $("#m-vocab").replaceChildren(...hits.map((v) => el("div", null, el("b", { lang: "nb" }, v.no), " = ", v.es)));
    const c = item.context || {};
    $("#m-ctx").replaceChildren(
      c.prev ? el("div", null, "Antes: ", el("b", { lang: "nb" }, c.prev.no), el("i", null, c.prev.es)) : "",
      c.next ? el("div", null, "Después: ", el("b", { lang: "nb" }, c.next.no), el("i", null, c.next.es)) : "");
    const inReview = review.active;
    $("#m-count").hidden = !inReview;
    if (inReview) $("#m-count").textContent = "Duda " + (review.i + 1) + " de " + review.items.length;
    $("#m-kicker").textContent = inReview ? "Repaso" : "Esto significa:";
    $("#meaning").hidden = false;
    $("#m-go").focus({ preventScroll: true });
    stopClip();
    speakEs(item.es, { resume: false }).then(() => {
      if (token !== meaning.token || $("#meaning").hidden) return;
      startAutoContinue(token);
    });
  }

  function stopClip() { clipEnd = null; }

  function closeMeaningCard() {
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
    if (item && item.es) speakEs(item.es, { resume: false });
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
  }
  function dismissOnBackdrop(overlay, closeFn) {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeFn(); });
  }

  function applyTop() {
    document.documentElement.classList.toggle("top-hidden", !!prefs.hideTop);
    const un = $("#btn-unhide");
    if (un) {
      un.setAttribute("aria-hidden", prefs.hideTop ? "false" : "true");
      un.tabIndex = prefs.hideTop ? 0 : -1;
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
    $("#btn-speak").addEventListener("click", () => { const l = lines[lineAt(audio.currentTime)]; speakEs(l.es); });
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
