// Norwegian Study Buddy: driving-friendly episode player (UI en español).
(function () {
  "use strict";
  const NSB = window.NSB;
  const { $, $$, el, fmtTime, toast, fetchJSON, lsGet, lsSet } = NSB;
  const cfg = window.NSB_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const slug = (params.get("ep") || "hvordan-unnga-tankekjor").replace(/[^a-z0-9-]/g, "");
  const PREFS_KEY = "nsb:prefs";
  const prefs = Object.assign({ es: true, autoSpeak: true, autoResume: true, follow: true, askedPass: false, rate: 1, voiceURI: "" }, lsGet(PREFS_KEY, {}));
  const savePrefs = () => lsSet(PREFS_KEY, prefs);
  let serverConfigured = null;

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
    store.onAuthError = () => toast("Contraseña incorrecta: tus dudas siguen guardadas aquí");
    store.on(onStoreChange);
    store.load();

    $("#loading").hidden = true;
    $("#top").hidden = false;
    $("#dock").hidden = false;
    setupMediaSession();
    wire();
    applyRate();
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
    const manual = () => { stage.dataset.manual = "1"; clearTimeout(t); t = setTimeout(() => delete stage.dataset.manual, 5000); };
    stage.addEventListener("wheel", manual, { passive: true });
    stage.addEventListener("touchmove", manual, { passive: true });
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
    if (scroll && prefs.follow && !$("#stage").dataset.manual) n.scrollIntoView({ block: "center", behavior: "smooth" });
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
      previoustrack: () => (review.active ? review.go(-1) : lineStep(-1)),
      nexttrack: () => (review.active ? review.go(1) : lineStep(1)),
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

  // ---------- "No entendí" ----------
  const lineInfo = (l) => (l ? { no: l.text, es: l.es || "" } : null);
  function markDoubt() {
    stopSpeech();
    const wasPlaying = !audio.paused;
    const t = Math.max(0, (audio.currentTime || 0) - 2);
    const i = lineAt(t);
    const l = lines[i];
    const item = {
      kind: "duda", id: "d-" + Date.now().toString(36), ep: slug, t: Math.round(t * 10) / 10, lineIndex: i,
      no: l.text, es: l.es || "",
      context: { prev: lineInfo(lines[i - 1]), next: lineInfo(lines[i + 1]) },
      vocab: vocabIn(l.text).map((v) => ({ no: v.no, es: v.es })),
      created: new Date().toISOString(),
    };
    store.add({ segmentId: l.seg.id, start: item.t, type: "highlight", text: JSON.stringify(item) });
    if (navigator.vibrate) navigator.vibrate(60);
    pause();
    showMeaning(item, wasPlaying);
  }

  let meaningResume = false;
  function showMeaning(item, wasPlaying) {
    meaningResume = wasPlaying;
    $("#m-es").textContent = item.es || "(sin traducción)";
    $("#m-no").textContent = item.no;
    const hits = item.vocab && item.vocab.length ? item.vocab : vocabIn(item.no).map((v) => ({ no: v.no, es: v.es }));
    $("#m-vocab").replaceChildren(...hits.map((v) => el("div", null, el("b", { lang: "nb" }, v.no), " = ", v.es)));
    const c = item.context || {};
    $("#m-ctx").replaceChildren(
      c.prev ? el("div", null, "Antes: ", el("b", { lang: "nb" }, c.prev.no), el("i", null, c.prev.es)) : "",
      c.next ? el("div", null, "Después: ", el("b", { lang: "nb" }, c.next.no), el("i", null, c.next.es)) : "");
    $("#meaning").hidden = false;
    $("#m-go").focus({ preventScroll: true });
    $("#meaning").dataset.t = item.t;
    if (prefs.autoSpeak) {
      speakEs(item.es, { resume: false }).then(() => {
        if (prefs.autoResume && meaningResume && !$("#meaning").hidden) setTimeout(() => { if (!$("#meaning").hidden) closeMeaning(true); }, 1200);
      });
    }
  }
  function closeMeaning(resume) {
    stopSpeech();
    $("#meaning").hidden = true;
    if (resume) play();
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
    $("#sync-dot").dataset.state = store.state;
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
      return el("div", { class: "item" + (d.pending ? " syncing" : "") },
        el("button", { class: "main", type: "button", onclick: () => { closePanel(); seek(d.t - 1); play(); } },
          el("span", { class: "when" }, "▶ " + fmtTime(d.t)),
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
        seg && el("button", { class: "tab", type: "button", style: "justify-self:start;margin-top:4px", onclick: () => { closePanel(); seek(seg.start); } }, "▶ " + fmtTime(seg.start))));
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

  // ---------- review mode ("Repasar todo") ----------
  const review = {
    active: false, i: 0, items: [], token: 0, LISTEN: 10,
    start() {
      this.items = dudas();
      if (!this.items.length) return;
      this.active = true; this.i = 0;
      closePanel();
      $("#review").hidden = false;
      this.run();
    },
    async run() {
      const my = ++this.token;
      const d = this.items[this.i];
      $("#r-count").textContent = "Duda " + (this.i + 1) + " de " + this.items.length;
      $("#r-es").textContent = d.es;
      $("#r-no").textContent = d.no;
      $("#r-phase").textContent = "Escucha";
      stopSpeech();
      seek(d.t - 3);
      play();
      const from = audio.currentTime;
      await waitFor(() => audio.currentTime >= from + this.LISTEN || audio.ended, this.LISTEN * 1000 + 4000, () => my !== this.token);
      if (my !== this.token) return;
      pause();
      $("#r-phase").textContent = "Significa";
      await speakEs(d.es, { resume: false });
      if (my !== this.token) return;
      await sleep(900);
      if (my !== this.token) return;
      if (this.i < this.items.length - 1) { this.i++; this.run(); }
      else { this.stop(); toast("Repaso terminado"); }
    },
    go(dir) {
      if (!this.active) return;
      this.i = Math.max(0, Math.min(this.items.length - 1, this.i + dir));
      this.run();
    },
    stop() {
      this.token++; this.active = false;
      stopSpeech(); pause();
      $("#review").hidden = true;
    },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function waitFor(cond, timeout, cancelled) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (cancelled() || cond() || Date.now() - t0 > timeout) { clearInterval(iv); resolve(); }
      }, 200);
    });
  }

  // ---------- settings ----------
  function statusText() {
    if (serverConfigured === false) {
      return "⚠️ El servidor aún no tiene contraseña configurada. Tus dudas se guardan solo en este dispositivo.";
    }
    const n = store ? store.pending.length : 0;
    switch (store && store.state) {
      case "synced": return "✅ Guardado en la nube.";
      case "saving": return "⏳ Guardando en la nube…";
      case "pending": return "⏳ " + n + " cambio(s) por sincronizar.";
      case "local": return "📱 Solo en este dispositivo" + (n ? " (" + n + " sin subir)" : "") + ". Añade la contraseña para sincronizar.";
      case "offline": return "📴 Sin conexión. Se sincroniza al volver la conexión.";
      case "auth": return "❌ Contraseña incorrecta. Tus dudas siguen guardadas aquí.";
      case "error":
        if (NSB.isPassphraseUnconfigured(store)) return "⚠️ El servidor aún no tiene contraseña configurada. Tus dudas se guardan solo en este dispositivo.";
        return "⚠️ " + (store.detail || "Problema al sincronizar. Se reintentará.");
      default: return NSB.passphrase.get() ? "Listo." : "📱 Solo en este dispositivo.";
    }
  }
  function renderStatus() {
    const box = $("#s-status");
    const text = statusText();
    box.textContent = text;
    box.classList.toggle("warn", serverConfigured === false || NSB.isPassphraseUnconfigured(store));
    box.classList.toggle("err", !!(store && store.state === "auth"));
  }
  function closeSettings() { $("#settings").hidden = true; }
  function closeMore() { $("#more").hidden = true; }
  function openMore() { $("#more").hidden = false; applyRate(); pickVoice(); }
  function openSettings(msg) {
    closeMore();
    $("#settings").hidden = false;
    $("#s-pass").value = "";
    $("#s-pass").placeholder = NSB.passphrase.get() ? "•••••• (guardada)" : "Solo para guardar en la nube";
    $("#s-autospeak").checked = prefs.autoSpeak;
    $("#s-autoresume").checked = prefs.autoResume;
    $("#s-follow").checked = prefs.follow;
    $("#s-about").textContent = msg || "";
    renderStatus();
    checkServerConfig();
  }
  async function checkServerConfig() {
    if (!cfg.workerUrl) return;
    try {
      const h = await fetchJSON(cfg.workerUrl.replace(/\/+$/, "") + "/health", { cache: "no-store" });
      serverConfigured = !!(h && h.configured);
    } catch (_) { /* offline or blocked; keep the last known status */ }
    renderStatus();
  }
  function dismissOnBackdrop(overlay, closeFn) {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeFn(); });
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

    $("#m-go").addEventListener("click", () => closeMeaning(true));
    $("#m-speak").addEventListener("click", () => speakEs($("#m-es").textContent, { resume: false }));
    $("#m-replay").addEventListener("click", () => { meaningResume = false; closeMeaning(false); seek(+$("#meaning").dataset.t - 3); play(); });

    $("#btn-dudas").addEventListener("click", () => openPanel("dudas"));
    $("#panel-close").addEventListener("click", closePanel);
    $("#panel-close-2").addEventListener("click", closePanel);
    $$(".tab[data-tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
    $("#btn-review").addEventListener("click", () => review.start());
    $("#r-stop").addEventListener("click", () => review.stop());
    $("#r-prev").addEventListener("click", () => review.go(-1));
    $("#r-next").addEventListener("click", () => review.go(1));

    $("#btn-more").addEventListener("click", openMore);
    $("#more-close").addEventListener("click", closeMore);
    $("#btn-settings").addEventListener("click", () => openSettings());
    $("#settings-close").addEventListener("click", closeSettings);
    $("#settings-close-2").addEventListener("click", closeSettings);
    dismissOnBackdrop($("#more"), closeMore);
    dismissOnBackdrop($("#settings"), closeSettings);
    dismissOnBackdrop($("#panel"), closePanel);
    dismissOnBackdrop($("#meaning"), () => closeMeaning(true));
    dismissOnBackdrop($("#review"), () => review.stop());
    $("#s-save").addEventListener("click", async () => {
      const v = $("#s-pass").value.trim();
      if (v) {
        NSB.passphrase.set(v);
        toast("Contraseña guardada en este dispositivo");
      }
      $("#s-pass").value = "";
      $("#s-pass").placeholder = NSB.passphrase.get() ? "•••••• (guardada)" : "Solo para guardar en la nube";
      await checkServerConfig();
      if (serverConfigured !== false) store.flush();
    });
    $("#s-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#s-save").click(); });
    $("#s-forget").addEventListener("click", () => { NSB.passphrase.forget(); store.setState("local"); toast("Contraseña olvidada en este dispositivo"); openSettings(); });
    $("#s-autospeak").addEventListener("change", (e) => { prefs.autoSpeak = e.target.checked; savePrefs(); });
    $("#s-autoresume").addEventListener("change", (e) => { prefs.autoResume = e.target.checked; savePrefs(); });
    $("#s-follow").addEventListener("change", (e) => { prefs.follow = e.target.checked; savePrefs(); });
    $("#s-export").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ ep: slug, exported: new Date().toISOString(), dudas: dudas() }, null, 2)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: "mis-dudas-" + slug + ".json" });
      document.body.append(a); a.click(); a.remove();
    });

    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input,textarea,select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (!$("#meaning").hidden) return closeMeaning(true);
        if (review.active) return review.stop();
        if (!$("#settings").hidden) return closeSettings();
        if (!$("#more").hidden) return closeMore();
        $("#panel").hidden = true; return;
      }
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
