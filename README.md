# Norwegian Study Buddy 🇳🇴

A driving-friendly page for learning Norwegian with podcasts, with the interface in Spanish.
Plain HTML/CSS/JS, no build step.

**Hub:** https://ried.cl/Norwegian-Study-Buddy/

The tankekjør episode: [open the episode](https://ried.cl/Norwegian-Study-Buddy/episode.html?ep=hvordan-unnga-tankekjor).

`https://eried.github.io/Norwegian-Study-Buddy/` and the previous Cloudflare address both redirect here.

## What it does
- Plays the original NRK MP3 and shows the full transcript **line by line**, with the current line highlighted and scrolled into view.
- Every line has a **Spanish translation** (`lines[].es`, marked as *traducción automática*), which you can show or hide.
- **Leer ES** reads the current line's Spanish aloud with the browser's Web Speech API (`es-ES`). The audio pauses while it speaks and then resumes.
- A giant **«No entendí»** button marks the moment (about 2 s back) and shows an "Esto significa" card with the Spanish, the Norwegian, the previous and next lines, and any matching vocabulary. It can read the meaning aloud and save it to **Mis dudas**.
- **Mis dudas**: tap an item to replay from 3 s before it. **Repasar todo** plays about 10 s around each saved point, then reads the Spanish aloud. You can also delete items.
- Huge −10 s / play / +10 s buttons (hold −10 s or +10 s to jump a whole line), plus previous/next line buttons.
- **Media Session API** support: lock screen, Bluetooth and steering-wheel buttons work (play/pause, seek ±10 s, previous/next track = previous/next line, seek-to), with artwork from NRK.
- Keyboard shortcuts: Space, ←/→, ↑/↓, N (No entendí), L (leer), E (español), D (dudas).

## Files
```
index.html                 episode list (+ open an MP3 / RSS URL)
episode.html?ep=<slug>     player
config.js                  Worker URL (the only place it lives)
assets/                    style.css, common.js, notes.js (local-first sync store), player.js, index.js
vendor/marked.min.js       markdown for the study notes tab
episodes/index.json        episode list
episodes/<slug>/transcript.json   segments → lines {start,end,text,es}, titleEs, vocabulary {no,en,es}
episodes/<slug>/study-notes.md    study pack (English)
notes/<slug>.json          written by the Worker (do not edit by hand)
```

## Saving without a login
1. **localStorage first.** Every duda is saved on the device right away, so it works offline.
2. **Optional cloud sync.** Enter a shared passphrase once in Ajustes. The page sends each change to the Cloudflare Worker `norwegian-study-buddy-notes` (`GET/POST /notes/<slug>`, header `X-Passphrase`). The Worker commits `notes/<slug>.json` to this repo using its own fine-grained GitHub token, so no token ever reaches the browser. A duda is stored as a note of type `highlight` whose `text` is the duda's JSON (`kind: "duda"`). If `SAVE_PASSPHRASE` has not been set on the Worker, `/health` reports `configured: false`, writes return HTTP 503 (`passphrase not configured on server`), and Ajustes explains in Spanish that the server has no password yet. Your dudas still stay on the device.
3. Changes made offline or before a passphrase is entered are queued and sync later. The sync dot on the gear button shows the status: green = synced, yellow = only on this device or pending, red = wrong passphrase or error.

Note: the repo is public, so synced dudas are public too.

## Adding an episode
Add `episodes/<slug>/transcript.json` in the same shape and list it in `episodes/index.json`.
Audio is streamed from the publisher. No audio files are committed.

## Hosting and deploying
`index.html` is the hub for every language study: it groups entries by the `lang` field in `episodes/index.json` (for example `"lang": "no"`). Existing episode URLs such as `episode.html?ep=hvordan-unnga-tankekjor` stay the same. New languages can later use folders like `episodes/<lang>/<slug>/` without moving the studies already in the repo.

The site is served by GitHub Pages from the `main` branch root, at `https://ried.cl/Norwegian-Study-Buddy/` (a project-site subpath on the custom domain; `eried.github.io` redirects there). Cloudflare Worker `norwegian-study-buddy` 301s path and query to that hub (`tools/redirect-worker.js`).

Cloudflare Worker `norwegian-study-buddy-notes` is the save/password backend (`GET/POST /notes/<slug>`). CORS allows `https://eried.github.io` and the older Workers / Pages origins. `config.js` points at that Worker.

To update the notes Worker, upload `tools/notes-worker.js` (keep the existing `GITHUB_TOKEN` binding; set `SAVE_PASSPHRASE` separately). The optional bundled-site helper is still `python3 tools/build-site-worker.py`.
