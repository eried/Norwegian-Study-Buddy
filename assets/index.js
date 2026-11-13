(function () {
  "use strict";
  const { $, el, fmtDuration, fmtDate, fetchJSON } = window.NSB;
  const playIcon = () => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.innerHTML = '<path fill="currentColor" d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>';
    return s;
  };

  (async function () {
    const box = $("#episodes");
    try {
      const data = await fetchJSON("episodes/index.json", { cache: "no-cache" });
      const eps = (data.episodes || []).slice().sort((a, b) => String(b.published).localeCompare(String(a.published)));
      box.replaceChildren(...eps.map((ep) => el("a", { class: "ep", href: "episode.html?ep=" + encodeURIComponent(ep.slug) },
        ep.image ? el("img", { src: ep.image, alt: "" }) : null,
        el("div", null, el("b", { lang: "nb" }, ep.title),
          el("small", null, [ep.show, fmtDuration(ep.durationSec), fmtDate(ep.published)].filter(Boolean).join(" · ")),
          ep.descriptionEs && el("small", null, ep.descriptionEs)),
        el("span", { class: "go", "aria-hidden": "true" }, playIcon()))));
      if (!eps.length) box.replaceChildren(el("div", { class: "empty" }, "Todavía no hay episodios."));
    } catch (e) {
      box.replaceChildren(el("div", { class: "empty" }, "No se pudo cargar la lista (" + e.message + ")."));
    }
  })();

  const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)(\?|#|$)/i;
  const out = $("#loader-out");
  const show = (...n) => out.replaceChildren(...n);
  const notice = (kind, ...c) => el("div", { class: "notice " + kind, role: kind === "err" ? "alert" : "status" }, ...c);
  function player(src, title) {
    const a = el("audio", { controls: true, preload: "metadata", src, style: "width:100%;margin-top:8px" });
    a.addEventListener("error", () => a.replaceWith(notice("err", "No se pudo reproducir este audio.")));
    return notice("", el("b", null, title || "Audio"), el("div", { class: "hint" }, "Sin transcripción todavía."), a);
  }

  $("#loader").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const url = $("#src").value.trim();
    let u;
    try { u = new URL(url); } catch (e) { return show(notice("err", "Eso no parece un enlace (debe empezar por https://).")); }
    if (AUDIO_RE.test(u.pathname)) return show(player(url, decodeURIComponent(u.pathname.split("/").pop())));
    show(notice("", "Leyendo el feed…"));
    let text;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (/^(audio|video)\//.test(res.headers.get("content-type") || "")) return show(player(url));
      text = await res.text();
    } catch (e) {
      return show(notice("err", el("b", null, "No se pudo leer este feed desde el navegador. "),
        "La mayoría de servidores de pódcasts no permiten que otras webs lean su feed (regla de seguridad CORS). Pega mejor el enlace directo al MP3. ",
        el("div", { style: "margin-top:10px" }, el("button", { class: "tbtn", type: "button", onclick: () => show(player(url)) }, "Probar como audio"))));
    }
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const items = Array.from(doc.querySelectorAll("item, entry"));
    if (doc.querySelector("parsererror") || !items.length) return show(notice("err", "Esto no parece un feed de pódcast."));
    const list = el("ul", { class: "feed-list" });
    for (const it of items.slice(0, 100)) {
      const enc = it.querySelector("enclosure[url]");
      if (!enc) continue;
      const title = (it.querySelector("title") || {}).textContent || "Sin título";
      const date = (it.querySelector("pubDate") || {}).textContent;
      list.append(el("li", null, el("button", { type: "button", onclick: () => list.replaceWith(player(enc.getAttribute("url"), title)) },
        title, el("small", null, date ? fmtDate(new Date(date).toISOString()) : ""))));
    }
    show(notice("", el("b", null, (doc.querySelector("channel > title") || {}).textContent || "Feed"), list));
  });
})();
