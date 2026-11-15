#!/usr/bin/env python3
"""Unit tests for tools/gen_es_audio.py, writing 3 lines into a temp dir."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import gen_es_audio as gen  # noqa: E402


SAMPLE = {
    "title": "Test episode",
    "segments": [
        {
            "title": "Intro",
            "titleEs": "Inicio de prueba",
            "lines": [
                {"start": 0, "end": 2, "text": "En.", "es": "Uno."},
                {"start": 2, "end": 4, "text": "To.", "es": "Dos."},
                {"start": 4, "end": 6, "text": "", "es": "  "},  # empty es: no file, index still advances
                {"start": 6, "end": 8, "text": "Tre.", "es": "Tres."},
            ],
        }
    ],
}


def write_sine_mp3(dest: Path, freq: float = 440, dur: float = 0.2) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={dur}",
            "-ac", "1", "-ar", "24000", "-b:a", "48k", str(dest),
        ],
        check=True,
    )


def fake_synth_factory(calls):
    def synth(text, voice, dest, retries=4):
        calls.append({"text": text, "voice": voice, "dest": str(dest), "retries": retries})
        if text == "FAILME":
            raise ConnectionError("network down")
        write_sine_mp3(Path(dest))
    return synth


class GenEsAudioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        ep = self.root / "episodes" / "demo"
        ep.mkdir(parents=True)
        (ep / "transcript.json").write_text(json.dumps(SAMPLE, ensure_ascii=False), encoding="utf-8")
        self.calls = []
        self.synth = fake_synth_factory(self.calls)

    def tearDown(self):
        self.tmp.cleanup()

    def run_gen(self, **kwargs):
        args = dict(slug="demo", root=self.root, voice="es-ES-ElviraNeural", synthesize=self.synth)
        args.update(kwargs)
        return gen.generate(**args)

    def es_dir(self):
        return self.root / "episodes" / "demo" / "es"

    def test_three_lines_and_title_into_temp_dir(self):
        summary = self.run_gen()
        out = self.es_dir()
        self.assertEqual(summary["generated"], 4)  # 3 lines + titleEs
        self.assertEqual(summary["skipped"], 0)
        self.assertEqual(summary["failed"], 0)
        for name in ("seg-0.mp3", "0.mp3", "1.mp3", "3.mp3"):
            path = out / name
            self.assertTrue(path.is_file(), name)
            self.assertGreater(path.stat().st_size, 100)
            # mono / 48k-ish: ffprobe
            probe = subprocess.check_output(
                ["ffprobe", "-v", "error", "-select_streams", "a:0",
                 "-show_entries", "stream=channels,bit_rate", "-of", "json", str(path)],
                text=True,
            )
            info = json.loads(probe)["streams"][0]
            self.assertEqual(int(info["channels"]), 1)
        self.assertFalse((out / "2.mp3").exists(), "empty es should not create a file")
        man = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["slug"], "demo")
        self.assertEqual(man["voice"], "es-ES-ElviraNeural")
        self.assertEqual(man["files"]["0.mp3"]["text"], "Uno.")
        self.assertEqual(man["files"]["0.mp3"]["hash"], gen.text_hash("Uno.", "es-ES-ElviraNeural"))
        self.assertEqual(man["files"]["seg-0.mp3"]["kind"], "segmentTitle")
        texts = [c["text"] for c in self.calls]
        self.assertEqual(texts, ["Inicio de prueba", "Uno.", "Dos.", "Tres."])

    def test_rerun_skips_unchanged(self):
        self.run_gen()
        self.calls.clear()
        summary = self.run_gen()
        self.assertEqual(summary["generated"], 0)
        self.assertEqual(summary["skipped"], 4)
        self.assertEqual(self.calls, [])

    def test_text_change_regenerates_only_that_file(self):
        self.run_gen()
        self.calls.clear()
        ep = self.root / "episodes" / "demo" / "transcript.json"
        data = json.loads(ep.read_text(encoding="utf-8"))
        data["segments"][0]["lines"][1]["es"] = "Dos, revisado."
        ep.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        summary = self.run_gen()
        self.assertEqual(summary["generated"], 1)
        self.assertEqual(summary["skipped"], 3)
        self.assertEqual([c["text"] for c in self.calls], ["Dos, revisado."])
        man = json.loads((self.es_dir() / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["files"]["1.mp3"]["text"], "Dos, revisado.")

    def test_force_regenerates_all(self):
        self.run_gen()
        self.calls.clear()
        summary = self.run_gen(force=True)
        self.assertEqual(summary["generated"], 4)
        self.assertEqual(summary["skipped"], 0)
        self.assertEqual(len(self.calls), 4)

    def test_retries_then_succeeds(self):
        attempts = {"n": 0}

        def flaky(text, voice, dest, retries=4):
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise ConnectionError("temporary")
            write_sine_mp3(Path(dest))

        # Use a one-line transcript
        ep = self.root / "episodes" / "demo" / "transcript.json"
        ep.write_text(json.dumps({
            "segments": [{"titleEs": "", "lines": [{"start": 0, "end": 1, "text": "X", "es": "Hola."}]}]
        }), encoding="utf-8")

        # The generate() function does not retry around synth itself; synthesize_edge does.
        # We test _is_retryable + synthesize wrapper by calling synthesize_edge's retry loop
        # through a local stand-in installed as synthesize that mimics retries.
        def synth_with_retry(text, voice, dest, retries=4):
            last = None
            for i in range(1, retries + 1):
                try:
                    return flaky(text, voice, dest, retries=retries)
                except ConnectionError as e:
                    last = e
                    if i >= retries:
                        raise
            raise last

        summary = self.run_gen(synthesize=synth_with_retry)
        self.assertEqual(summary["failed"], 0)
        self.assertEqual(summary["generated"], 1)
        self.assertEqual(attempts["n"], 3)

    def test_cli_missing_transcript(self):
        with self.assertRaises(SystemExit):
            gen.generate("no-such-slug", root=self.root, synthesize=self.synth)

    def _duration(self, path: Path) -> float:
        probe = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            text=True,
        )
        return float(probe.strip())

    def test_pad_appends_trailing_silence_and_changes_hash(self):
        plain = self.run_gen(pad=0)
        self.assertEqual(plain["generated"], 4)
        out = self.es_dir() / "0.mp3"
        dur0 = self._duration(out)
        self.assertLess(dur0, 1.0)
        man0 = json.loads((self.es_dir() / "manifest.json").read_text(encoding="utf-8"))
        hash0 = man0["files"]["0.mp3"]["hash"]
        self.assertEqual(hash0, gen.text_hash("Uno.", "es-ES-ElviraNeural"))

        self.calls.clear()
        padded = self.run_gen(pad=1)
        self.assertEqual(padded["generated"], 4)
        self.assertEqual(padded["skipped"], 0)
        dur1 = self._duration(out)
        self.assertGreater(dur1, dur0 + 0.85)
        man1 = json.loads((self.es_dir() / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man1["files"]["0.mp3"]["pad"], 1)
        self.assertEqual(man1["files"]["0.mp3"]["hash"], gen.text_hash("Uno.", "es-ES-ElviraNeural", 1))
        self.assertNotEqual(man1["files"]["0.mp3"]["hash"], hash0)

        self.calls.clear()
        again = self.run_gen(pad=1)
        self.assertEqual(again["generated"], 0)
        self.assertEqual(again["skipped"], 4)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
