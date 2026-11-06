"""Exercise the actual Python 3.9 example and its application-owned transforms."""
import csv
import io
from pathlib import Path
import threading
import unittest
import zipfile
from urllib.request import urlopen

from examples.server import DeviceServer
from tests.support import ROOT  # Also configures the project's browser cache.
from playwright.sync_api import sync_playwright, expect


class DemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = DeviceServer(("127.0.0.1", 0), rate=10)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.stopped.set()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_example_serves_a_flushed_event_stream(self):
        with urlopen(self.url + "/events", timeout=3) as response:
            self.assertEqual(response.headers.get_content_type(), "text/event-stream")
            self.assertEqual(response.headers["Cache-Control"], "no-cache")
            self.assertEqual(response.readline(), b"retry: 2000\n")
            self.assertEqual(response.readline(), b"\n")
            self.assertTrue(response.readline().startswith(b"id: "))
            self.assertEqual(response.readline(), b"event: log\n")
            self.assertIn(b"refreshing snapshot", response.readline())

    def test_example_page_is_styled_by_turbo_sse_css_alone(self):
        with urlopen(self.url + "/", timeout=3) as response:
            html = response.read().decode("utf-8")
        self.assertNotIn("demo.css", html)
        self.assertNotIn(" class=", html)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                for width, columns in ((3000, 2), (1100, 2), (390, 1)):
                    page = browser.new_page(viewport={"width": width, "height": 900})
                    page.goto(self.url)
                    expect(page.locator(".turbo-sse-status")).to_have_text("Connected")
                    expect(page.locator("#device-state")).to_have_text("Running")
                    layout = page.evaluate("""() => {
                        const [left, right, third] = [...document.querySelectorAll("main > section")].map(s => s.getBoundingClientRect());
                        return {sideBySide: Math.abs(left.top - right.top) < 1 && right.left > left.right, stacked: right.top >= left.bottom, newRow: third.top >= left.bottom,
                                tableShare: document.querySelector("main > table").getBoundingClientRect().width / document.querySelector("main").clientWidth,
                                overflow: document.documentElement.scrollWidth > innerWidth,
                                table: getComputedStyle(document.querySelector("table")).borderCollapse,
                                caption: getComputedStyle(document.querySelector("caption")).backgroundImage,
                                plotHeader: getComputedStyle(document.querySelector(".turbo-sse-plot > header")).backgroundImage,
                                value: getComputedStyle(document.querySelector("tbody td")).textAlign,
                                pre: getComputedStyle(document.querySelector("pre")).whiteSpace};
                    }""")
                    self.assertEqual(layout["sideBySide"], columns == 2, (width, layout))
                    self.assertEqual(layout["stacked"], columns == 1, (width, layout))
                    self.assertFalse(layout["overflow"], width)
                    # At most two plots share a row; a table is as wide as its content.
                    self.assertTrue(layout["newRow"], (width, layout))
                    if width > 1000:
                        self.assertLess(layout["tableShare"], .5, (width, layout))
                    self.assertEqual(layout["table"], "collapse")
                    # Gloss belongs to the interface: page captions are quiet titles, plot headers title bars.
                    # A label-and-value table reads like a menu list, with its values on the right.
                    self.assertEqual(layout["caption"], "none")
                    self.assertTrue(layout["plotHeader"].startswith("linear-gradient"), layout)
                    self.assertEqual(layout["value"], "right")
                    self.assertEqual(layout["pre"], "pre-wrap")
                    self.assertEqual(page.locator("main > table caption").text_content(), "Real-time values")
                    # The topbar content lines up with the page content, which is at most 1600 px wide.
                    edges = page.evaluate("""() => { const main = document.querySelector("main"), style = getComputedStyle(main), box = main.getBoundingClientRect();
                        return [box.left + parseFloat(style.paddingLeft), box.right - parseFloat(style.paddingRight),
                                document.querySelector(".turbo-sse-status").getBoundingClientRect().left,
                                document.querySelector(".turbo-sse-export").getBoundingClientRect().right, box.width]; }""")
                    self.assertAlmostEqual(edges[2], edges[0], delta=1, msg=(width, edges))
                    self.assertAlmostEqual(edges[3], edges[1], delta=1, msg=(width, edges))
                    self.assertLessEqual(edges[4], 1600)
                    # Horizontal y labels still keep the y-axis gutter narrow; it widens only for the lane names.
                    self.assertTrue(all(int(left[:-2]) <= 80 for left in page.evaluate('[...document.querySelectorAll(".turbo-sse-tools")].map(t => t.style.left)')), width)
                    # The plot band stays one row, so it takes little from the fixed-height plot area.
                    self.assertTrue(all(h <= 24 for h in page.evaluate('[...document.querySelectorAll(".turbo-sse-tools")].map(t => t.offsetHeight)')), width)
                    page.close()
            finally:
                browser.close()

    def test_example_page_transforms_and_exports(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1100, "height": 900}, accept_downloads=True)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                page.goto(self.url)
                expect(page.locator(".turbo-sse-status")).to_have_text("Connected")
                expect(page.locator('#temperature-value')).to_contain_text("°C")
                expect(page.locator('#voltage-value')).to_contain_text("mV")
                expect(page.locator('#device-state')).to_have_text("Running")
                page.wait_for_function("TurboSSE.stats().retained >= 6")
                expect(page.locator(".turbo-sse-counts")).not_to_contain_text("Captured 0")
                output = ROOT / "test-results"
                output.mkdir(exist_ok=True)
                page.screenshot(path=str(output / "demo.png"), full_page=True)
                with page.expect_download() as archive:
                    page.locator(".turbo-sse-export").click()
                with zipfile.ZipFile(archive.value.path()) as z:
                    self.assertIsNone(z.testzip())
                    self.assertEqual(z.namelist(), ["export.txt", "raw-events.csv", "s01-Inlet-temperature.csv", "s02-Outlet-temperature.csv",
                                                    "s03-Pump.csv", "s04-Motor-speed.csv", "s05-Controller.csv", "s06-Supply-voltage.csv", "s07-Status.csv"])
                    self.assertIn("diagnostic", z.read("raw-events.csv").decode("utf-8"))
                    # Lane files list the values held; the controller lane starts in one of its four states.
                    controller = list(csv.DictReader(io.StringIO(z.read("s05-Controller.csv").decode("utf-8"))))
                    self.assertIn(controller[0]["value"], ("IDLE", "RAMP UP", "RUN", "RAMP DOWN"))
                    self.assertIn("lane", z.read("export.txt").decode("utf-8"))
                expect(page.locator(".turbo-sse-uptime")).to_contain_text("Uptime ≈")
                # J, two letters and Enter reach every plot of the example.
                for host in page.locator("[data-sse-graph]").all():
                    title = host.locator(".turbo-sse-plot > header strong").inner_text()
                    page.keyboard.press("j")
                    page.locator(".turbo-sse-menu input").fill(title[:2].lower())
                    page.keyboard.press("Enter")
                    expect(host.locator(".turbo-sse-plot")).to_have_attribute("data-active", "")
                self.assertEqual(errors, [])
            finally:
                browser.close()
