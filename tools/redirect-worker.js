// 301 the old workers.dev host to the GitHub Pages hub, keeping path and query.
const HUB = "https://eried.github.io/Norwegian-Study-Buddy";
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/" : url.pathname;
    const dest = HUB + path + url.search;
    return new Response(null, { status: 301, headers: { Location: dest, "Cache-Control": "no-store" } });
  }
};
