import worker, { checkPassphrase } from "./notes-worker.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function req(method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request("https://norwegian-study-buddy-notes.example" + path, init);
}

const addBody = { action: "add", segmentId: "s1", start: 12, type: "highlight", text: '{"kind":"duda"}' };

// Unit: checkPassphrase
{
  const r1 = checkPassphrase({}, req("POST", "/notes/x", { headers: { "X-Passphrase": "123" } }));
  assert(r1.status === 503 && r1.error === "passphrase not configured on server", "unset secret should be 503, got " + JSON.stringify(r1));

  const r2 = checkPassphrase({ SAVE_PASSPHRASE: "secret" }, req("POST", "/notes/x", { headers: { "X-Passphrase": "123" } }));
  assert(r2.status === 401 && r2.error === "wrong passphrase", "wrong pass should be 401");

  const r3 = checkPassphrase({ SAVE_PASSPHRASE: "secret" }, req("POST", "/notes/x", { headers: { "X-Passphrase": "secret" } }));
  assert(r3.ok === true, "correct pass should be ok");

  const r4 = checkPassphrase({ SAVE_PASSPHRASE: "  secret  " }, req("POST", "/notes/x", { headers: { "X-Passphrase": "secret" } }));
  assert(r4.ok === true, "trim on stored secret");

  const r5 = checkPassphrase({ SAVE_PASSPHRASE: "secret" }, req("POST", "/notes/x", { headers: { "X-Passphrase": "  secret  " } }));
  assert(r5.ok === true, "trim on header");

  const r6 = checkPassphrase({ SAVE_PASSPHRASE: "secret" }, req("POST", "/notes/x"));
  assert(r6.status === 401, "missing header is 401 when configured");
  console.log("checkPassphrase: ok");
}

// Integration: worker.fetch
{
  const envUnconfigured = { GITHUB_TOKEN: "ghs_test" };
  let res = await worker.fetch(req("GET", "/health"), envUnconfigured);
  let body = await res.json();
  assert(res.status === 200 && body.configured === false, "health unconfigured, got " + JSON.stringify(body));

  res = await worker.fetch(req("POST", "/notes/hvordan-unnga-tankekjor", { headers: { "X-Passphrase": "123" }, body: addBody }), envUnconfigured);
  body = await res.json();
  assert(res.status === 503 && body.error === "passphrase not configured on server", "POST unconfigured: " + res.status + " " + JSON.stringify(body));

  const envConfigured = { GITHUB_TOKEN: "ghs_test", SAVE_PASSPHRASE: "correct-phrase" };
  res = await worker.fetch(req("GET", "/health"), envConfigured);
  body = await res.json();
  assert(body.configured === true, "health configured");

  res = await worker.fetch(req("POST", "/notes/hvordan-unnga-tankekjor", { headers: { "X-Passphrase": "123" }, body: addBody }), envConfigured);
  body = await res.json();
  assert(res.status === 401 && body.error === "wrong passphrase", "wrong pass through fetch");

  // Correct passphrase: stub GitHub fetch so we never hit the network
  const notes = { slug: "hvordan-unnga-tankekjor", notes: [] };
  const sha = "abc123";
  const content = Buffer.from(JSON.stringify(notes), "utf8").toString("base64");
  const origFetch = globalThis.fetch;
  let wrote = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "PUT") {
      wrote = true;
      const sent = JSON.parse(init.body);
      const saved = JSON.parse(Buffer.from(sent.content, "base64").toString("utf8"));
      assert(saved.notes.length === 1, "should write one note");
      return new Response(JSON.stringify({ content: { sha: "def" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/contents/notes/")) {
      return new Response(JSON.stringify({ sha, content }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected fetch " + u);
  };
  try {
    res = await worker.fetch(req("POST", "/notes/hvordan-unnga-tankekjor", { headers: { "X-Passphrase": "  correct-phrase  " }, body: addBody }), envConfigured);
    body = await res.json();
    assert(res.status === 200, "correct pass should succeed, got " + res.status + " " + JSON.stringify(body));
    assert(Array.isArray(body.notes) && body.notes.length === 1, "returned notes");
    assert(wrote, "GitHub write was attempted");
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log("worker.fetch: ok");
}

console.log("All passphrase tests passed.");
