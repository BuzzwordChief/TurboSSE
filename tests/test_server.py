import gzip
from pathlib import Path
import unittest

from examples.server import encode_event


class EncoderTests(unittest.TestCase):
    def test_multiline_unicode_and_trailing_newline(self):
        self.assertEqual(encode_event('µ, "ok"\nnext\n', "log", "boot:1"),
                         'id: boot:1\nevent: log\ndata: µ, "ok"\ndata: next\ndata: \n\n'.encode("utf-8"))

    def test_empty_payload_and_id_reset(self):
        self.assertEqual(encode_event("", event_id=""), b"id: \ndata: \n\n")

    def test_normalize_line_endings(self):
        self.assertEqual(encode_event("a\r\nb\rc"), b"data: a\ndata: b\ndata: c\n\n")

    def test_metadata_cannot_inject_frames(self):
        for bad in ("log\ndata: injected", "\r", "\0"):
            with self.assertRaises(ValueError):
                encode_event("a", event=bad)
            with self.assertRaises(ValueError):
                encode_event("a", event_id=bad)
        with self.assertRaises(TypeError):
            encode_event({"not": "a string"})

    def test_distribution_budget_and_gzip_files(self):
        root = Path(__file__).resolve().parents[1]
        total = 0
        for name in ("turbo-sse.min.js", "turbo-sse.css"):
            asset = root / "dist" / name
            compressed = asset.with_name(name + ".gz").read_bytes()
            self.assertEqual(gzip.decompress(compressed), asset.read_bytes())
            total += len(compressed)
        self.assertLessEqual(total, 5120)
