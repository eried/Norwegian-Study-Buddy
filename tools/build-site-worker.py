# Bundles the static site into one Cloudflare Worker script (tools/site-worker.js, git-ignored)
# and a deploy snippet for the Cloudflare API (tools/deploy-execute.js). Run: python3 tools/build-site-worker.py
import os,hashlib,json
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.md':'text/markdown; charset=utf-8'}
files={}
for dp,dn,fn in os.walk(root):
  dn[:]=[d for d in dn if d not in ('.git','tools')]
  for f in fn:
    p=os.path.join(dp,f); rel='/'+os.path.relpath(p,root)
    if f.startswith('.') or rel=='/README.md': continue
    t=open(p,encoding='utf-8').read()
    files[rel]={'t':types[os.path.splitext(f)[1]],'e':'"'+hashlib.sha256(t.encode()).hexdigest()[:16]+'"','b':t}
worker="const FILES = "+json.dumps(files,ensure_ascii=False)+""";
const ALIASES = { '/': '/index.html', '/episode': '/episode.html', '/index': '/index.html' };
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    let path = decodeURIComponent(url.pathname);
    path = ALIASES[path] || path;
    if (!FILES[path] && FILES[path.replace(/\\/$/, '') + '.html']) path = path.replace(/\\/$/, '') + '.html';
    const f = FILES[path];
    if (!f) return new Response('<!doctype html><meta charset=utf-8><body style="background:#000;color:#fff;font:20px system-ui;padding:30px">No encontrado. <a style="color:#4cc2ff" href="/">Volver</a>', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const headers = { 'content-type': f.t, 'etag': f.e, 'cache-control': /\\.(html|json|md)$/.test(path) || path === '/config.js' ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
    if (request.headers.get('if-none-match') === f.e) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : f.b, { headers });
  }
};
"""
open(os.path.join(root,'tools','site-worker.js'),'w').write(worker)
js="""async () => {
const WORKER = %s;
const NAME = 'norwegian-study-buddy';
const metadata = { main_module: 'worker.js', compatibility_date: '2026-11-01' };
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
form.append('worker.js', new Blob([WORKER], { type: 'application/javascript+module' }), 'worker.js');
const put = await cloudflare.request({ method: 'PUT', path: `/accounts/${accountId}/workers/scripts/${NAME}`, body: form });
let sub; try { sub = (await cloudflare.request({ method: 'POST', path: `/accounts/${accountId}/workers/scripts/${NAME}/subdomain`, body: { enabled: true, previews_enabled: false } })).result; } catch (e) { sub = String(e.message || e).slice(0, 300); }
return { success: put.success, errors: put.errors, etag: put.result && put.result.etag, subdomain: sub };
}""" % json.dumps(worker, ensure_ascii=False)
open(os.path.join(root,'tools','deploy-execute.js'),'w').write(js)
print(len(worker))
