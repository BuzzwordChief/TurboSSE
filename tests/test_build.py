"""Verify the generated firmware header using real C and C++ compilers."""
from contextlib import redirect_stdout
import gzip
import io
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools import build


ROOT = Path(__file__).resolve().parents[1]


class HeaderTests(unittest.TestCase):
    def compile_and_compare(self, compiler_name, standard, suffix, compressed=False):
        compiler = shutil.which(compiler_name)
        if compiler is None:
            self.skipTest("{} is required to compile the header".format(compiler_name))
        with tempfile.TemporaryDirectory() as directory:
            symbol = "turbo_sse_js_gz" if compressed else "turbo_sse_js"
            source = Path(directory) / ("export" + suffix)
            executable = Path(directory) / "export"
            source.write_text(
                '#include "turbo-sse.h"\n'
                '#include "turbo-sse.h"\n'  # Exercise the include guard too.
                '#include "turbo-sse-gzip.h"\n'
                '#include "turbo-sse-gzip.h"\n'
                '#include <stdio.h>\n'
                'int main(void) {\n'
                '    if (turbo_sse_js_len != sizeof(turbo_sse_js)) return 1;\n'
                '    if (turbo_sse_js_gz_len != sizeof(turbo_sse_js_gz)) return 1;\n'
                '    return fwrite(' + symbol + ', 1, ' + symbol + '_len, stdout) == ' + symbol + '_len ? 0 : 1;\n'
                '}\n', encoding="ascii")
            subprocess.run(
                [compiler, "-std=" + standard, "-pedantic-errors", "-Wall", "-Wextra", "-Werror",
                 "-I", str(ROOT / "dist"), str(source), "-o", str(executable)],
                check=True, capture_output=True)
            output = subprocess.run([str(executable)], check=True, capture_output=True).stdout
            asset = "turbo-sse.min.js.gz" if compressed else "turbo-sse.min.js"
            self.assertEqual(output, (ROOT / "dist" / asset).read_bytes())
            if compressed:
                self.assertEqual(gzip.decompress(output), (ROOT / "dist/turbo-sse.min.js").read_bytes())

    def test_header_round_trips_exact_js_bytes_in_c(self):
        self.compile_and_compare("cc", "c99", ".c")

    def test_header_round_trips_exact_js_bytes_in_cpp(self):
        self.compile_and_compare("c++", "c++11", ".cpp")

    def test_gzip_header_round_trips_exact_js_bytes_in_c(self):
        self.compile_and_compare("cc", "c99", ".c", compressed=True)

    def test_gzip_header_round_trips_exact_js_bytes_in_cpp(self):
        self.compile_and_compare("c++", "c++11", ".cpp", compressed=True)

    def test_check_detects_missing_or_stale_header(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(ROOT / "src", root / "src")
            with patch.object(build, "ROOT", root), redirect_stdout(io.StringIO()):
                build.build()
                build.build(check=True)
                for name in ("turbo-sse.h", "turbo-sse-gzip.h"):
                    with self.subTest(header=name):
                        header = root / "dist" / name
                        original = header.read_bytes()
                        header.write_bytes(original + b"/* stale */\n")
                        with self.assertRaises(SystemExit) as error:
                            build.build(check=True)
                        self.assertEqual(str(error.exception), "Stale build: " + str(header))
                        header.unlink()
                        with self.assertRaises(SystemExit) as error:
                            build.build(check=True)
                        self.assertEqual(str(error.exception), "Stale build: " + str(header))
                        header.write_bytes(original)
