"""Build standalone assets and check the 5 KiB gzip budget (Python 3.9+)."""
import argparse
import gzip
from pathlib import Path
import re

import rjsmin


ROOT = Path(__file__).resolve().parents[1]


def build(check=False):
    javascript = (ROOT / "src/turbo-sse.js").read_text(encoding="utf-8")
    css = (ROOT / "src/turbo-sse.css").read_text(encoding="utf-8")
    css = re.sub(r"\s+", " ", css)
    css = re.sub(r"\s*([{}:;,])\s*", r"\1", css).strip()
    outputs = {
        "turbo-sse.min.js": rjsmin.jsmin(javascript).encode("utf-8"),
        "turbo-sse.css": css.encode("utf-8"),
    }
    destination = ROOT / "dist"
    destination.mkdir(exist_ok=True)
    total = 0
    for name, contents in outputs.items():
        zipped = gzip.compress(contents, compresslevel=9, mtime=0)
        total += len(zipped)
        for filename, data in ((name, contents), (name + ".gz", zipped)):
            path = destination / filename
            if check:
                if not path.exists() or path.read_bytes() != data:
                    raise SystemExit("Stale build: " + str(path))
            else:
                path.write_bytes(data)
        print("{}: {} bytes minified, {} bytes gzip".format(name, len(contents), len(zipped)))
    print("JavaScript source: {} bytes".format(len(javascript.encode("utf-8"))))
    print("Combined gzip: {} / 5120 bytes".format(total))
    if total > 5120:
        raise SystemExit("Bundle exceeds the 5 KiB gzip budget")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify committed assets without rewriting them")
    build(parser.parse_args().check)
