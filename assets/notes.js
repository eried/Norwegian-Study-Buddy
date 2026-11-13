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
      this.state = "local";
      this.detail = "";
      this.cloudOk = false;      // true only after a successful authenticated write
      this.rejectedPass = null;  // last passphrase that got 401/403; do not retry it
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
      this.setState(this.uiState());
      this.flush();
    }

    uiState() {
      if (this.cloudOk && this.flushing) return "saving";
      if (this.cloudOk && this.pending.length) return "pending";
      if (this.cloudOk) return "synced";
      return "local";
    }

    async load() {
      this.emit();
      if (!this.api) return;
      try {
        const data = await NSB.fetchJSON(this.api + "/notes/" + encodeURIComponent(this.slug), { cache: "no-store" });
        this.server = Array.isArray(data.notes) ? data.notes : [];
        this.lastSync = new Date().toISOString();
        this.persist();
        this.setState(this.uiState());
      } catch (e) {
        // Worker unreachable: try the static copy committed to the repo, else keep the local cache.
        if (this.fallbackUrl) {
          try {
            const data = await NSB.fetchJSON(this.fallbackUrl, { cache: "no-store" });
            if (Array.isArray(data.notes)) { this.server = data.notes; this.persist(); }
          } catch (_) { /* no static copy yet */ }
        }
        this.setState(this.uiState());
        return;
      }
      this.flush();
    }

    async flush() {
      if (this.flushing || !this.pending.length || !this.api) return;
      const pass = NSB.passphrase.get();
      if (!pass || pass === this.rejectedPass) { this.setState("local"); return; }
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
            this.setState(this.uiState());
            return;
          }
          op.inFlight = false;
          if (op.deleted && !res.ok) { this.pending.shift(); this.persist(); continue; }
          if (res.status === 401 || res.status === 403) {
            this.rejectedPass = pass;
            this.cloudOk = false;
            this.setState("local");
            return;
          }
          if (res.status === 503) {
            this.setState(this.uiState());
            return;
          }
          if (res.status === 404 && op.action !== "add") {
            // The note no longer exists on the server; drop the operation.
            this.pending.shift();
            this.persist();
            continue;
          }
          if (!res.ok) {
            this.setState(this.uiState());
            return;
          }
          let data = null;
          try { data = await res.json(); } catch (_) {}
          this.pending.shift();
          this.cloudOk = true;
          this.rejectedPass = null;
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
        this.setState(this.uiState());
      } finally {
        this.flushing = false;
        this.setState(this.uiState());
      }
    }

    exportJSON() {
      return JSON.stringify({ slug: this.slug, exported: new Date().toISOString(), notes: this.notes.map(({ _pending, ...n }) => n) }, null, 2);
    }
  }

  NSB.NotesStore = NotesStore;

  NSB.syncLabel = function (store) {
    if (store && store.cloudOk && store.state === "saving") return ["Saving…", "Saving"];
    if (store && store.cloudOk && store.state === "pending") return ["Saving…", "Saving"];
    if (store && store.cloudOk) return ["Synced", "Saved"];
    return ["Ready", "Saved on this device"];
  };
})();
