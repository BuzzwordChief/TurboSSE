"""Exercise the actual Python 3.9 example and its application-owned transforms."""
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
                expect(page.locator(".turbo-sse-counts")).not_to_contain_text("Captured: 0")
                output = ROOT / "test-results"
                output.mkdir(exist_ok=True)
                page.screenshot(path=str(output / "demo.png"), full_page=True)
                with page.expect_download() as archive:
                    page.locator(".turbo-sse-export").click()
                with zipfile.ZipFile(archive.value.path()) as z:
                    self.assertIsNone(z.testzip())
                    self.assertEqual(z.namelist(), ["export.txt", "raw-events.csv", "s01-Inlet-temperature.csv",
                                                    "s02-Outlet-temperature.csv", "s03-Motor-speed.csv", "s04-Supply-voltage.csv"])
                    self.assertIn("diagnostic", z.read("raw-events.csv").decode("utf-8"))
                expect(page.locator(".turbo-sse-uptime")).to_contain_text("Uptime ≈")
                self.assertEqual(errors, [])
            finally:
                browser.close()
