// Cloudflare Worker: sync notes/<slug>.json into eried/Norwegian-Study-Buddy.
// Secrets: GITHUB_TOKEN (required), SAVE_PASSPHRASE (required for POST).
const REPO = "eried/Norwegian-Study-Buddy";
const BRANCH = "main";
const ALLOWED = [
  "https://norwegian-study-buddy.pages.dev",
  "https://norwegian-study-buddy.erwin-ce6.workers.dev",
  "https://eried.github.io",
  "https://ried.cl",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];
const ALLOWED_RE = [/^https:\/\/[a-z0-9-]+\.norwegian-study-buddy\.pages\.dev$/];

function allowed(origin) {
  return ALLOWED.includes(origin) || ALLOWED_RE.some((r) => r.test(origin));
}

function cors(req) {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allowed(origin) ? origin : ALLOWED[0],
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Passphrase",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(req, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) },
  });
}

function b64e(s) {
  const b = new TextEncoder().encode(s);
  let out = "";
  for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(out);
}

const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

async function gh(env, path, init = {}) {
  return fetch("https://api.github.com/repos/" + REPO + "/contents/" + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "norwegian-study-buddy-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

async function readNotes(env, slug) {
  const r = await gh(env, "notes/" + slug + ".json?ref=" + BRANCH);
  if (r.status === 404) return { sha: null, data: { slug, notes: [] } };
  if (!r.ok) throw new Error("GitHub read " + r.status);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(b64d(j.content)) };
}

function checkPassphrase(env, req) {
  if (!env.SAVE_PASSPHRASE) return { ok: false, status: 503, error: "passphrase not configured on server" };
  const got = String(req.headers.get("X-Passphrase") || "").trim();
  if (got !== String(env.SAVE_PASSPHRASE).trim()) return { ok: false, status: 401, error: "wrong passphrase" };
  return { ok: true };
}

export { checkPassphrase };

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/notes\/([a-z0-9-]{1,80})$/);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json(req, {
        ok: true,
        service: "norwegian-study-buddy notes",
        configured: !!(env.GITHUB_TOKEN && env.SAVE_PASSPHRASE),
      });
    }
    if (!m) return json(req, { error: "not found" }, 404);
    const slug = m[1];
    if (!env.GITHUB_TOKEN) return json(req, { error: "GITHUB_TOKEN secret not set" }, 503);
    try {
      if (req.method === "GET") {
        const { data } = await readNotes(env, slug);
        return json(req, data);
      }
      if (req.method === "POST") {
        const auth = checkPassphrase(env, req);
        if (!auth.ok) return json(req, { error: auth.error }, auth.status);
        const body = await req.json();
        const action = body.action || "add";
        for (let attempt = 0; attempt < 3; attempt++) {
          const { sha, data } = await readNotes(env, slug);
          if (action === "add") {
            const n = {
              id: crypto.randomUUID(),
              segmentId: String(body.segmentId || ""),
              start: Number(body.start) || 0,
              type: ["note", "comment", "highlight"].includes(body.type) ? body.type : "note",
              text: String(body.text || "").slice(0, 5000),
              created: new Date().toISOString(),
            };
            data.notes.push(n);
          } else if (action === "delete") {
            data.notes = data.notes.filter((n) => n.id !== body.id);
          } else if (action === "edit") {
            const n = data.notes.find((x) => x.id === body.id);
            if (!n) return json(req, { error: "note not found" }, 404);
            n.text = String(body.text || "").slice(0, 5000);
            n.edited = new Date().toISOString();
          } else {
            return json(req, { error: "bad action" }, 400);
          }
          const put = await gh(env, "notes/" + slug + ".json", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: action + " note on " + slug,
              branch: BRANCH,
              content: b64e(JSON.stringify(data, null, 2) + "\n"),
              ...(sha ? { sha } : {}),
            }),
          });
          if (put.ok) return json(req, data);
          if (put.status !== 409 && put.status !== 422) throw new Error("GitHub write " + put.status + " " + (await put.text()));
        }
        return json(req, { error: "conflict, try again" }, 409);
      }
      return json(req, { error: "method not allowed" }, 405);
    } catch (e) {
      return json(req, { error: String(e.message || e) }, 502);
    }
  },
};
