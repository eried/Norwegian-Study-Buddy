#!/usr/bin/env python3
"""Generate Spanish MP3 clips for an episode transcript with edge-tts.

Usage:
  python tools/gen_es_audio.py <slug> [--voice es-ES-ElviraNeural] [--force]

Reads episodes/<slug>/transcript.json and writes small mono MP3s to
episodes/<slug>/es/<lineIndex>.mp3 (plus seg-<i>.mp3 for segment titleEs).
A manifest (es/manifest.json) stores a hash of voice+text so unchanged
files are skipped unless --force is passed.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

DEFAULT_VOICE = "es-ES-ElviraNeural"
DEFAULT_BITRATE = "48k"
DEFAULT_RATE = "24000"
RETRIES = 4
RETRY_BACKOFF = 1.5

ROOT_DEFAULT = Path(__file__).resolve().parent.parent


def text_hash(text: str, voice: str) -> str:
    h = hashlib.sha256()
    h.update(voice.encode("utf-8"))
    h.update(b"\n")
    h.update(text.encode("utf-8"))
    return h.hexdigest()


def load_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


def iter_jobs(transcript: dict):
    """Yield synthesis jobs in player line-index order."""
    line_i = 0
    for si, seg in enumerate(transcript.get("segments") or []):
        title = (seg.get("titleEs") or "").strip()
        if title:
            yield {
                "file": f"seg-{si}.mp3",
                "text": title,
                "kind": "segmentTitle",
                "index": si,
            }
        for line in seg.get("lines") or []:
            es = (line.get("es") or "").strip()
            if es:
                yield {
                    "file": f"{line_i}.mp3",
                    "text": es,
                    "kind": "line",
                    "index": line_i,
                }
            line_i += 1


def transcode_mono_mp3(src: Path, dest: Path, bitrate: str = DEFAULT_BITRATE, rate: str = DEFAULT_RATE) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(src),
            "-ac", "1", "-ar", rate, "-b:a", bitrate,
            "-vn", "-f", "mp3",
            str(tmp_path),
        ]
        subprocess.run(cmd, check=True)
        tmp_path.replace(dest)
    finally:
        if tmp_path.exists() and tmp_path != dest:
            tmp_path.unlink(missing_ok=True)


def _is_retryable(exc: BaseException) -> bool:
    name = type(exc).__name__
    if isinstance(exc, (TimeoutError, ConnectionError, OSError)):
        return True
    if "Client" in name or "Timeout" in name or "Network" in name or "Connect" in name:
        return True
    msg = str(exc).lower()
    return any(s in msg for s in ("timeout", "temporarily", "network", "connect", "reset", "503", "502", "429"))


async def _edge_save(text: str, voice: str, dest: Path) -> None:
    try:
        import edge_tts
    except ImportError as e:
        raise SystemExit(
            "edge-tts is not installed. Run:  pip install edge-tts\n"
            "or:  python3 -m venv .venv && .venv/bin/pip install edge-tts"
        ) from e
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(str(dest))


def synthesize_edge(text: str, voice: str, dest: Path, retries: int = RETRIES) -> None:
    """Download TTS audio to dest, retrying transient network errors."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    last = None
    attempts = max(1, retries)
    for attempt in range(1, attempts + 1):
        try:
            asyncio.run(_edge_save(text, voice, dest))
            if not dest.exists() or dest.stat().st_size < 64:
                raise RuntimeError(f"edge-tts produced no audio for {dest.name}")
            return
        except SystemExit:
            raise
        except Exception as e:
            last = e
            if attempt >= attempts or not _is_retryable(e):
                raise
            wait = RETRY_BACKOFF ** (attempt - 1)
            print(f"  retry {attempt}/{attempts} for {dest.name} after {e} (sleep {wait:.1f}s)", file=sys.stderr)
            time.sleep(wait)
    raise last  # pragma: no cover


def load_manifest(path: Path) -> dict:
    if not path.exists():
        return {"files": {}}
    try:
        data = load_json(path)
    except (json.JSONDecodeError, OSError):
        return {"files": {}}
    files = data.get("files")
    if not isinstance(files, dict):
        data["files"] = {}
    return data


def should_skip(job: dict, dest: Path, manifest: dict, voice: str, force: bool) -> bool:
    if force:
        return False
    if not dest.exists() or dest.stat().st_size < 64:
        return False
    entry = (manifest.get("files") or {}).get(job["file"]) or {}
    expected = text_hash(job["text"], voice)
    return entry.get("hash") == expected and entry.get("voice") == voice


def generate(
    slug: str,
    *,
    root: Path = ROOT_DEFAULT,
    voice: str = DEFAULT_VOICE,
    force: bool = False,
    bitrate: str = DEFAULT_BITRATE,
    synthesize=None,
    retries: int = RETRIES,
) -> dict:
    transcript_path = root / "episodes" / slug / "transcript.json"
    if not transcript_path.is_file():
        raise SystemExit(f"transcript not found: {transcript_path}")
    transcript = load_json(transcript_path)
    out_dir = root / "episodes" / slug / "es"
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.json"
    manifest = load_manifest(manifest_path)
    files = dict(manifest.get("files") or {})
    synth = synthesize or synthesize_edge

    jobs = list(iter_jobs(transcript))
    generated = skipped = failed = 0
    errors = []

    for job in jobs:
        dest = out_dir / job["file"]
        digest = text_hash(job["text"], voice)
        if should_skip(job, dest, manifest, voice, force):
            skipped += 1
            print(f"skip  {job['file']}")
            continue
        raw = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
                raw = Path(tmp.name)
            print(f"make  {job['file']}  ({job['kind']} {job['index']})")
            synth(job["text"], voice, raw, retries=retries)
            transcode_mono_mp3(raw, dest, bitrate=bitrate)
            files[job["file"]] = {
                "hash": digest,
                "text": job["text"],
                "voice": voice,
                "kind": job["kind"],
                "index": job["index"],
                "bytes": dest.stat().st_size,
            }
            generated += 1
        except Exception as e:
            failed += 1
            errors.append(f"{job['file']}: {e}")
            print(f"FAIL  {job['file']}: {e}", file=sys.stderr)
        finally:
            if raw is not None:
                raw.unlink(missing_ok=True)

    # Drop manifest entries whose files disappeared
    for name in list(files):
        if not (out_dir / name).exists():
            files.pop(name, None)

    manifest = {
        "slug": slug,
        "voice": voice,
        "files": files,
    }
    write_json(manifest_path, manifest)

    summary = {
        "slug": slug,
        "voice": voice,
        "out_dir": str(out_dir),
        "jobs": len(jobs),
        "generated": generated,
        "skipped": skipped,
        "failed": failed,
        "errors": errors,
    }
    print()
    print(f"slug={slug}  voice={voice}")
    print(f"generated: {generated}")
    print(f"skipped:   {skipped}")
    print(f"failed:    {failed}")
    print(f"wrote:     {out_dir}")
    return summary


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Generate Spanish MP3s for an episode with edge-tts.",
    )
    p.add_argument("slug", help="episode slug (folder under episodes/)")
    p.add_argument("--voice", default=DEFAULT_VOICE, help=f"edge-tts voice (default: {DEFAULT_VOICE})")
    p.add_argument("--force", action="store_true", help="regenerate files even when the text is unchanged")
    p.add_argument("--root", type=Path, default=ROOT_DEFAULT, help="repo root (default: parent of tools/)")
    p.add_argument("--bitrate", default=DEFAULT_BITRATE, help="MP3 bitrate (default: 48k)")
    return p.parse_args(argv)


def main(argv=None, synthesize=None) -> int:
    args = parse_args(argv)
    summary = generate(
        args.slug,
        root=args.root,
        voice=args.voice,
        force=args.force,
        bitrate=args.bitrate,
        synthesize=synthesize,
    )
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
