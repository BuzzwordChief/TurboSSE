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
    def compile_and_compare(self, compiler_name, standard, suffix, asset):
        compiler = shutil.which(compiler_name)
        if compiler is None:
            self.skipTest("{} is required to compile the header".format(compiler_name))
        with tempfile.TemporaryDirectory() as directory:
            symbol = build.HEADERS[asset][0]
            source = Path(directory) / ("export" + suffix)
            executable = Path(directory) / "export"
            includes = "".join('#include "{0}.h"\n#include "{0}.h"\n'.format(name)  # Exercise the include guards too.
                               for name in build.HEADERS)
            checks = "".join("    if ({0}_len != sizeof({0})) return 1;\n".format(name)
                             for name, _ in build.HEADERS.values())
            source.write_text(
                includes
                + '#include <stdio.h>\n'
                'int main(void) {\n'
                + checks
                + '    return fwrite(' + symbol + ', 1, ' + symbol + '_len, stdout) == ' + symbol + '_len ? 0 : 1;\n'
                '}\n', encoding="ascii")
            subprocess.run(
                [compiler, "-std=" + standard, "-pedantic-errors", "-Wall", "-Wextra", "-Werror",
                 "-I", str(ROOT / "dist"), str(source), "-o", str(executable)],
                check=True, capture_output=True)
            output = subprocess.run([str(executable)], check=True, capture_output=True).stdout
            self.assertEqual(output, (ROOT / "dist" / asset).read_bytes())
            if asset.endswith(".gz"):
                self.assertEqual(gzip.decompress(output), (ROOT / "dist" / asset[:-3]).read_bytes())

    def test_header_round_trips_exact_js_bytes_in_c(self):
        self.compile_and_compare("cc", "c99", ".c", "turbo-sse.min.js")

    def test_header_round_trips_exact_js_bytes_in_cpp(self):
        self.compile_and_compare("c++", "c++11", ".cpp", "turbo-sse.min.js")

    def test_gzip_header_round_trips_exact_js_bytes_in_c(self):
        self.compile_and_compare("cc", "c99", ".c", "turbo-sse.min.js.gz")

    def test_gzip_header_round_trips_exact_js_bytes_in_cpp(self):
        self.compile_and_compare("c++", "c++11", ".cpp", "turbo-sse.min.js.gz")

    def test_header_round_trips_exact_css_bytes_in_c(self):
        self.compile_and_compare("cc", "c99", ".c", "turbo-sse.css")

    def test_header_round_trips_exact_css_bytes_in_cpp(self):
        self.compile_and_compare("c++", "c++11", ".cpp", "turbo-sse.css")

    def test_gzip_header_round_trips_exact_css_bytes_in_c(self):
        self.compile_and_compare("cc", "c99", ".c", "turbo-sse.css.gz")

    def test_gzip_header_round_trips_exact_css_bytes_in_cpp(self):
        self.compile_and_compare("c++", "c++11", ".cpp", "turbo-sse.css.gz")

    def test_check_detects_missing_or_stale_header(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(ROOT / "src", root / "src")
            with patch.object(build, "ROOT", root), redirect_stdout(io.StringIO()):
                build.build()
                build.build(check=True)
                for name in (asset + ".h" for asset in build.HEADERS):
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
