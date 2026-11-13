// Notes store: local-first cache in localStorage + sync to the Cloudflare Worker.
// The Worker commits notes/<slug>.json to the GitHub repo; the page never holds a GitHub token.
(function () {
  "use strict";
  const NSB = (window.NSB = window.NSB || {});
  const PASS_KEY = "nsb:passphrase";

  NSB.passphrase = {
    get: () => {
      try { return (localStorage.getItem(PASS_KEY) || "").trim(); } catch (e) { return ""; }
    },
    set: (v) => { try { localStorage.setItem(PASS_KEY, String(v || "").trim()); } catch (e) {} },
    forget: () => { try { localStorage.removeItem(PASS_KEY); } catch (e) {} },
  };

  const uid = () => "local-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  class NotesStore {
    constructor(slug, opts = {}) {
      this.slug = slug;
      this.api = (opts.workerUrl || "").replace(/\/+$/, "");
      this.fallbackUrl = opts.fallbackUrl || null; // static notes/<slug>.json on Pages
      this.key = "nsb:notes:" + slug;
      const cached = NSB.lsGet(this.key, null) || {};
      this.server = Array.isArray(cached.server) ? cached.server : [];
      this.pending = Array.isArray(cached.pending) ? cached.pending : [];
      this.pending.forEach((op) => { op.inFlight = false; });
      this.lastSync = cached.lastSync || null;
      this.state = this.pending.length ? "pending" : (this.lastSync ? "synced" : "idle");
      this.detail = "";
      this.listeners = new Set();
      this.flushing = false;
      this.retryMs = opts.retryIntervalMs || 30000;
      window.addEventListener("online", () => this.flush());
      setInterval(() => { if (this.pending.length && navigator.onLine !== false) this.flush(); }, this.retryMs);
    }

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit() { for (const fn of this.listeners) fn(this); }
    persist() {
      NSB.lsSet(this.key, { server: this.server, pending: this.pending, lastSync: this.lastSync });
    }
    setState(state, detail = "") { this.state = state; this.detail = detail; this.emit(); }

    // Server notes with pending operations applied on top.
    get notes() {
      let list = this.server.map((n) => ({ ...n }));
      for (const op of this.pending) {
        if (op.action === "add") { if (!op.deleted) list.push({ ...op.note, _pending: true }); }
        else if (op.action === "edit") {
          const n = list.find((x) => x.id === op.id);
          if (n) { n.text = op.text; n.edited = op.at; n._pending = true; }
        } else if (op.action === "delete") list = list.filter((x) => x.id !== op.id);
      }
      return list.sort((a, b) => (a.start - b.start) || String(a.created).localeCompare(String(b.created)));
    }

    forSegment(segmentId) { return this.notes.filter((n) => n.segmentId === segmentId); }

    add({ segmentId, start, type, text }) {
      const note = { id: uid(), segmentId, start, type, text, created: new Date().toISOString() };
      this.pending.push({ opId: uid(), action: "add", note });
      this.changed();
      return note;
    }

    edit(id, text) {
      const localAdd = this.pending.find((op) => op.action === "add" && op.note.id === id);
      if (localAdd) localAdd.note.text = text;
      else {
        const prior = this.pending.find((op) => op.action === "edit" && op.id === id);
        if (prior) { prior.text = text; prior.at = new Date().toISOString(); }
        else this.pending.push({ opId: uid(), action: "edit", id, text, at: new Date().toISOString() });
      }
      this.changed();
    }

    remove(id) {
      const i = this.pending.findIndex((op) => op.action === "add" && op.note.id === id);
      if (i >= 0 && this.pending[i].inFlight) this.pending[i].deleted = true; // delete once the server id is known
      else if (i >= 0) this.pending.splice(i, 1);
      else {
        this.pending = this.pending.filter((op) => !(op.action === "edit" && op.id === id));
        this.pending.push({ opId: uid(), action: "delete", id });
      }
      this.changed();
    }

    changed() {
      this.persist();
      this.setState(this.pending.length ? "pending" : "synced");
      this.flush();
    }

    async load() {
      this.emit();
      if (!this.api) return;
      try {
        const data = await NSB.fetchJSON(this.api + "/notes/" + encodeURIComponent(this.slug), { cache: "no-store" });
        this.server = Array.isArray(data.notes) ? data.notes : [];
        this.lastSync = new Date().toISOString();
        this.persist();
        this.setState(this.pending.length ? "pending" : "synced");
      } catch (e) {
        // Worker unreachable: try the static copy committed to the repo, else keep the local cache.
        if (this.fallbackUrl) {
          try {
            const data = await NSB.fetchJSON(this.fallbackUrl, { cache: "no-store" });
            if (Array.isArray(data.notes)) { this.server = data.notes; this.persist(); }
          } catch (_) { /* no static copy yet */ }
        }
        this.setState(navigator.onLine === false ? "offline" : "error", "Couldn't reach the notes server. Showing notes saved on this device.");
        return;
      }
      this.flush();
    }

    async flush() {
      if (this.flushing || !this.pending.length || !this.api) return;
      const pass = NSB.passphrase.get();
      if (!pass) { this.setState("local", "Saved on this device. Add your passphrase to sync."); return; }
      this.flushing = true;
      try {
        while (this.pending.length) {
          const op = this.pending[0];
          let body;
          if (op.action === "add") {
            const { segmentId, start, type, text } = op.note;
            body = { action: "add", segmentId, start, type, text };
          } else if (op.action === "edit") body = { action: "edit", id: op.id, text: op.text };
          else body = { action: "delete", id: op.id };
          this.setState("saving");
          const sentText = op.action === "add" ? op.note.text : null;
          const beforeIds = new Set(this.server.map((n) => n.id));
          op.inFlight = true;
          let res;
          try {
            res = await fetch(this.api + "/notes/" + encodeURIComponent(this.slug), {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Passphrase": pass },
              body: JSON.stringify(body),
            });
          } catch (netErr) {
            op.inFlight = false;
            this.setState("offline", "Offline. Your notes are kept on this device and will sync later.");
            return;
          }
          op.inFlight = false;
          if (op.deleted && !res.ok) { this.pending.shift(); this.persist(); continue; }
          if (res.status === 503) {
            let msg = "El servidor aún no tiene contraseña configurada";
            try {
              const j = await res.json();
              if (j && /passphrase not configured/i.test(j.error || "")) msg = "El servidor aún no tiene contraseña configurada";
              else if (j && j.error) msg = j.error;
            } catch (_) {}
            this.setState("error", msg);
            if (typeof NSB.toast === "function") NSB.toast(msg);
            return;
          }
          if (res.status === 401 || res.status === 403) {
            this.setState("auth", "The passphrase was not accepted.");
            this.emitAuth();
            return;
          }
          if (res.status === 404 && op.action !== "add") {
            // The note no longer exists on the server; drop the operation.
            this.pending.shift();
            this.persist();
            continue;
          }
          if (!res.ok) {
            let msg = "Server error (" + res.status + "). Will retry.";
            try { const j = await res.json(); if (j && j.error) msg = j.error + " (" + res.status + "). Will retry."; } catch (_) {}
            this.setState("error", msg);
            return;
          }
          let data = null;
          try { data = await res.json(); } catch (_) {}
          this.pending.shift();
          if (data && Array.isArray(data.notes)) this.server = data.notes;
          if (op.action === "add") {
            // Changes made while the add was in flight: replay them against the new server id.
            const created = this.server.find((n) => !beforeIds.has(n.id) && n.segmentId === op.note.segmentId);
            if (created && op.deleted) this.pending.unshift({ opId: uid(), action: "delete", id: created.id });
            else if (created && op.note.text !== sentText) this.pending.unshift({ opId: uid(), action: "edit", id: created.id, text: op.note.text, at: new Date().toISOString() });
          }
          this.lastSync = new Date().toISOString();
          this.persist();
        }
        this.setState("synced");
      } finally {
        this.flushing = false;
      }
    }

    emitAuth() { if (typeof this.onAuthError === "function") this.onAuthError(); }

    exportJSON() {
      return JSON.stringify({ slug: this.slug, exported: new Date().toISOString(), notes: this.notes.map(({ _pending, ...n }) => n) }, null, 2);
    }
  }

  NSB.isPassphraseUnconfigured = function (store) {
    return !!(store && store.detail && /contraseña configurada|passphrase not configured/i.test(store.detail));
  };

  NSB.NotesStore = NotesStore;

  NSB.syncLabel = function (store) {
    const n = store.pending.length;
    switch (store.state) {
      case "synced": return ["Synced", "All notes saved to GitHub"];
      case "saving": return ["Saving…", "Saving to GitHub"];
      case "pending": return [n + " unsaved", n + " change(s) waiting to sync"];
      case "local": return ["On this device", "Add your passphrase to sync " + n + " change(s)"];
      case "offline": return ["Offline", n ? n + " change(s) will sync when you're back online" : "Showing cached notes"];
      case "auth": return ["Passphrase?", "The passphrase was not accepted"];
      case "error": return [NSB.isPassphraseUnconfigured(store) ? "Sin configurar" : "Sync problem", store.detail || "Will retry"];
      default: return ["Notes", "Notes"];
    }
  };
})();
