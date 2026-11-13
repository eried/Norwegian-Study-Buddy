// Shared helpers for Norwegian Study Buddy.
(function () {
  "use strict";
  const NSB = (window.NSB = window.NSB || {});

  NSB.$ = (sel, root = document) => root.querySelector(sel);
  NSB.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  NSB.el = function (tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  };

  NSB.fmtTime = function (sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
  };

  NSB.fmtDuration = function (sec) {
    const m = Math.round((sec || 0) / 60);
    return m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m + " min";
  };

  NSB.fmtDate = function (iso, opts) {
    if (!iso) return "";
    const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("es-ES", opts || { day: "numeric", month: "long", year: "numeric" });
  };

  NSB.fmtDateTime = function (iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  let toastTimer;
  NSB.toast = function (msg) {
    let t = document.querySelector(".toast");
    if (!t) {
      t = NSB.el("div", { class: "toast", role: "status", "aria-live": "polite" });
      document.body.append(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  };

  NSB.fetchJSON = async function (url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  NSB.lsGet = function (key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  };
  NSB.lsSet = function (key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  };
})();
