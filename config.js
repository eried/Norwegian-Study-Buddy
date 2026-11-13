// Norwegian Study Buddy configuration. The only place the Worker URL lives.
window.NSB_CONFIG = {
  // Cloudflare Worker that stores notes by committing notes/<slug>.json to this repo.
  workerUrl: "https://norwegian-study-buddy-notes.erwin-ce6.workers.dev",
  // Repo (used for links in the footer).
  repoUrl: "https://github.com/eried/norwegian-study-buddy",
  // How often to retry pending saves while online (ms).
  retryIntervalMs: 30000
};
