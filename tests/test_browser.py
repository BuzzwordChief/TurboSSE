"""Behavioral browser tests driven by Python 3.9 and a real local SSE server."""
import csv
import io
import json
import os
import time
import unittest
import zipfile

from tests.support import FixtureServer
from playwright.sync_api import sync_playwright, expect


class BrowserCases:
    @classmethod
    def setUpClass(cls):
        cls.server = FixtureServer()
        cls.playwright = sync_playwright().start()
        cls.browser = getattr(cls.playwright, cls.ENGINE).launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.close()

    def setUp(self):
        self.context = self.browser.new_context(accept_downloads=True)
        self.page = self.context.new_page()
        self.page.set_default_timeout(7000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Unexpected uncaught JavaScript errors")

    def open(self, markup, attributes="", functions="", connected=True):
        self.case, url = self.server.add(markup, attributes, functions)
        self.page.goto(url)
        if connected:
            expect(self.page.locator(".turbo-sse-status")).to_have_text("Connected")
        return self.case

    def received(self, count):
        self.page.wait_for_function("n => TurboSSE.stats().received >= n", arg=count, polling=20)

    def text(self, selector, text):
        expect(self.page.locator(selector)).to_have_text(text, use_inner_text=False)

    def stats(self):
        return self.page.evaluate("TurboSSE.stats()")

    def export(self):
        # Pages without graphs export the same ZIP: export.txt and raw-events.csv.
        with self.page.expect_download() as download_info:
            self.page.locator(".turbo-sse-export").click()
        with zipfile.ZipFile(download_info.value.path()) as archive:
            self.assertEqual(archive.namelist(), ["export.txt", "raw-events.csv"])
            return list(csv.DictReader(io.StringIO(archive.read("raw-events.csv").decode("utf-8"), newline="")))

    def wait_requests(self, count):
        deadline = time.monotonic() + 8
        while len(self.case.requests) < count and time.monotonic() < deadline:
            self.page.wait_for_timeout(20)
        self.assertGreaterEqual(len(self.case.requests), count)

    def test_raw_strings_default_event_and_explicit_html(self):
        self.open('<span id="raw" data-sse-event="value"></span>'
                  '<span id="copy" data-sse-event="value"></span>'
                  '<span id="html" data-sse-event="value" data-sse-format="html"></span>'
                  '<span id="unnamed" data-sse-event="message"></span>')
        self.case.emit("value", "0012")
        self.text("#raw", "0012")
        self.case.emit("value", '{"rpm":1450}')
        self.text("#raw", '{"rpm":1450}')
        self.case.emit("value", "<b>µ</b>")
        self.case.emit(None, "unnamed")
        self.text("#raw", "<b>µ</b>")
        self.text("#copy", "<b>µ</b>")
        self.text("#html b", "µ")
        self.text("#unnamed", "unnamed")
        self.assertEqual(self.page.locator("#raw b").count(), 0)

    def test_json_pointers_types_and_missing_paths(self):
        pointers = {"number": "/sensors/0/value", "escaped": "/a~1b/~0key", "boolean": "/flag", "null": "/empty", "object": "/nested", "missing": "/missing", "prototype": "/toString", "root": "", "badindex": "/sensors/00/value"}
        self.open("".join('<span id="{}" data-sse-event="json" data-sse-json="{}">initial</span>'.format(key, pointer) for key, pointer in pointers.items()))
        payload = {"sensors": [{"value": 12.5}], "a/b": {"~key": "ok"}, "flag": False, "empty": None, "nested": {"x": 1}}
        self.case.emit("json", json.dumps(payload))
        for key, value in (("number", "12.5"), ("escaped", "ok"), ("boolean", "false"), ("null", ""), ("object", '{"x":1}'), ("missing", "initial"), ("prototype", "initial"), ("badindex", "initial")):
            self.text("#" + key, value)
        self.text("#root", json.dumps(payload, separators=(",", ":")))

    def test_json_parsed_once_and_invalid_json_preserves_raw(self):
        self.open('<span id="a" data-sse-event="json" data-sse-json="/a">initial</span>'
                  '<span id="b" data-sse-event="json" data-sse-json="/b">initial</span>'
                  '<pre id="raw" data-sse-event="json"></pre>',
                  functions='window.parses=0; const original=JSON.parse; JSON.parse=function(...args){window.parses++;return original(...args);};')
        before = self.page.evaluate("window.parses")
        self.case.emit("json", '{"a":1,"b":2}')
        self.text("#a", "1")
        self.text("#b", "2")
        self.assertEqual(self.page.evaluate("window.parses"), before + 1)
        self.case.emit("json", "{broken")
        self.text("#raw", "{broken")
        self.text("#a", "1")
        self.assertEqual(self.stats()["parseErrors"], 1)
        self.assertEqual(self.export()[-1]["data"], "{broken")

    def test_transforms_raw_typed_json_and_append(self):
        self.open('<span id="raw" data-sse-event="temperature" data-sse-transform="degrees"></span>'
                  '<span id="json" data-sse-event="json" data-sse-json="/value" data-sse-transform="degrees"></span>'
                  '<pre id="log" data-sse-event="log" data-sse-transform="decorate" data-sse-swap="append"></pre>',
                  functions='window.inputs=[]; window.degrees=v=>{inputs.push(typeof v);return Number(v).toFixed(1)+" °C";}; window.decorate=v=>"["+v+"]";')
        self.case.emit("temperature", "23.60")
        self.case.emit("json", '{"value":24.5}')
        self.case.emit("log", "a")
        self.case.emit("log", "b")
        self.text("#raw", "23.6 °C")
        self.text("#json", "24.5 °C")
        self.text("#log", "[a][b]")
        self.assertEqual(self.page.evaluate("inputs"), ["string", "number"])
        self.assertEqual([r["data"] for r in self.export()], ["23.60", '{"value":24.5}', "a", "b"])

    def test_transform_errors_skips_and_null_are_isolated(self):
        self.open('<span id="null" data-sse-event="value" data-sse-transform="clear">old</span>'
                  '<span id="skip" data-sse-event="value" data-sse-transform="skip">old</span>'
                  '<span id="bad" data-sse-event="value" data-sse-transform="bad">old</span>'
                  '<span id="async" data-sse-event="value" data-sse-transform="later">old</span>'
                  '<span id="symbol" data-sse-event="value" data-sse-transform="symbol">old</span>'
                  '<span id="raw" data-sse-event="value"></span>',
                  functions='window.clear=()=>null; window.skip=()=>undefined; window.bad=()=>{throw Error("bad");}; window.later=async()=>{throw Error("async");}; window.symbol=()=>Symbol();')
        self.case.emit("value", "payload")
        self.text("#null", "")
        for selector in ("#skip", "#bad", "#async", "#symbol"):
            self.text(selector, "old")
        self.text("#raw", "payload")
        self.assertEqual(self.stats()["transformErrors"], 3)
        self.assertEqual(self.export()[0]["data"], "payload")

    def test_transform_registration_cache_and_refresh(self):
        self.open('<span id="value" data-sse-event="value" data-sse-transform="format">initial</span>')
        self.case.emit("value", "a")
        self.received(1)
        self.text("#value", "initial")
        self.assertEqual(self.stats()["configErrors"], 1)
        self.page.evaluate('window.format=v=>"A"+v; TurboSSE.refresh()')
        self.case.emit("value", "b")
        self.text("#value", "Ab")
        self.page.evaluate('window.format=v=>"B"+v')
        self.case.emit("value", "c")
        self.text("#value", "Ac")
        self.page.evaluate("TurboSSE.refresh()")
        self.case.emit("value", "d")
        self.text("#value", "Bd")
        self.assertEqual(len(self.case.requests), 1)

    def test_transform_output_uses_explicit_html_mode(self):
        self.open('<div id="text" data-sse-event="v" data-sse-transform="bold"></div>'
                  '<div id="html" data-sse-event="v" data-sse-transform="bold" data-sse-format="html"></div>',
                  functions='window.bold=v=>"<b>"+v+"</b>";')
        self.case.emit("v", "hello")
        self.text("#text", "<b>hello</b>")
        self.text("#html b", "hello")

    def test_append_limits_trim_whole_text_and_html_entries(self):
        self.open('<pre id="log" data-sse-event="log" data-sse-swap="append" data-sse-limit="2"></pre>'
                  '<div id="html" data-sse-event="html" data-sse-format="html" data-sse-swap="append" data-sse-limit="2"></div>')
        for value in ("a\n", "b\n", "c\n"):
            self.case.emit("log", value)
        for i in range(3):
            self.case.emit("html", '<b>{}</b><i>!</i>'.format(i))
            self.text("#html b:last-of-type", str(i))
        self.text("#log", "b\nc\n")
        self.text("#html", "1!2!")
        self.assertEqual(self.page.locator("#html > *").count(), 4)
        self.assertEqual(self.stats()["appendDrops"], 2)
        self.page.evaluate("TurboSSE.refresh()")
        self.case.emit("log", "d\n")
        self.text("#log", "c\nd\n")

    def test_hidden_render_queue_is_bounded_and_transforms_run_per_message(self):
        self.context.add_init_script('window.requestAnimationFrame=fn=>{window.flush=fn;return 1;};window.cancelAnimationFrame=()=>{};')
        self.open('<pre id="log" data-sse-event="v" data-sse-swap="append" data-sse-limit="3"></pre>'
                  '<span id="last" data-sse-event="v" data-sse-transform="count"></span>',
                  functions='window.calls=0; window.count=v=>{window.calls++;return v;};')
        for i in range(100):
            self.case.emit("v", str(i) + ",")
        self.received(100)
        self.assertEqual(self.page.evaluate("calls"), 100)
        self.assertEqual(self.stats()["appendDrops"], 97)
        self.assertEqual(self.page.locator("#log").text_content(), "")
        self.page.evaluate("window.flush()")
        self.text("#log", "97,98,99,")
        self.text("#last", "99,")
        self.assertEqual(self.stats()["retained"], 100)

    def test_transformed_append_byte_budget(self):
        self.open('<pre id="log" data-sse-event="v" data-sse-swap="append" data-sse-transform="expand"></pre>',
                  functions='window.expand=v=>v==="huge"?"x".repeat(131073):"y".repeat(70000);')
        self.case.emit("v", "small")
        self.received(1)
        self.page.wait_for_function('document.querySelector("#log").textContent.length===70000')
        self.case.emit("v", "small")
        self.case.emit("v", "huge")
        self.received(3)
        self.assertEqual(self.stats()["appendDrops"], 2)
        self.assertEqual(self.page.locator("#log").text_content(), "y" * 70000)

    def test_csv_preserves_payloads_and_capture_only_events(self):
        self.open('<span data-sse-event="visible"></span>', 'data-sse-events="diagnostic"')
        payloads = ['µ,"quoted"\nnext\n', ' { "x" : 12 } ', "0012", ""]
        for value in payloads:
            self.case.emit("diagnostic", value)
        self.case.emit("heartbeat", "alive")
        self.case.emit(None, "default")
        self.case.emit("undeclared", "not observable")
        self.received(6)
        rows = self.export()
        self.assertEqual([r["data"] for r in rows[:4]], payloads)
        self.assertEqual([r["event"] for r in rows], ["diagnostic"] * 4 + ["heartbeat", "message"])
        self.assertEqual(rows[0]["last_event_id"], "boot:1")
        self.assertTrue(rows[0]["received_at"].endswith("Z"))
        self.assertEqual(self.stats()["retained"], 6)
        self.assertEqual(self.stats()["state"], "Connected")

    def test_capture_event_limit_and_oversized_records(self):
        self.open('<span data-sse-event="v"></span>', 'data-sse-buffer-events="2" data-sse-buffer-bytes="100"')
        for value in ("a", "b", "c", "x" * 100):
            self.case.emit("v", value)
        self.received(4)
        self.assertEqual([r["data"] for r in self.export()], ["b", "c"])
        stats = self.stats()
        self.assertEqual((stats["evicted"], stats["oversized"]), (1, 1))
        self.assertLessEqual(stats["bytes"], 100)

    def test_capture_byte_limit_evicts_without_truncating(self):
        self.open('<span data-sse-event="v"></span>', 'data-sse-buffer-bytes="30"')
        self.case.emit("v", "1234567890", "")
        self.case.emit("v", "abcdefghij", "")
        self.received(2)
        self.assertEqual([r["data"] for r in self.export()], ["abcdefghij"])
        self.assertEqual(self.stats()["evicted"], 1)

    def test_reconnection_sends_last_event_id(self):
        self.open('<span id="v" data-sse-event="v"></span>')
        self.case.emit("v", "first", "bootA:42")
        self.text("#v", "first")
        self.case.disconnect()
        self.wait_requests(2)
        self.assertEqual(self.case.requests[1]["header"], "bootA:42")
        self.case.emit("v", "after", "bootA:43")
        self.text("#v", "after")
        self.assertEqual(self.stats()["received"], 2)

    def test_watchdog_restarts_with_encoded_resume_query(self):
        self.open('<span id="v" data-sse-event="v"></span>', 'data-sse-timeout="250"')
        self.case.emit("v", "first", "boot /+&:1")
        self.text("#v", "first")
        self.text(".turbo-sse-status", "Stalled")
        self.wait_requests(2)
        self.assertEqual(self.case.requests[1]["query"]["lastEventId"], ["boot /+&:1"])
        self.case.emit("v", "after")
        self.text("#v", "after")

    def test_heartbeats_reset_watchdog_but_comments_do_not(self):
        self.open('<span data-sse-event="v"></span>', 'data-sse-timeout="300"')
        for _ in range(5):
            self.case.emit("heartbeat", "alive")
            self.page.wait_for_timeout(100)
        self.assertEqual(len(self.case.requests), 1)
        self.text(".turbo-sse-status", "Connected")
        self.text(".turbo-sse-status", "Stalled")

    def test_terminal_close_and_manual_retry(self):
        self.case, url = self.server.add('<span id="v" data-sse-event="v"></span>')
        self.case.status = 204
        self.page.goto(url)
        self.text(".turbo-sse-status", "Disconnected")
        # The lit tab and the rule turn red, and Retry stands right after the tab.
        expect(self.page.locator(".turbo-sse-bar")).to_have_attribute("data-state", "disconnected")
        self.assertEqual(self.page.evaluate('document.querySelector(".turbo-sse-status").nextElementSibling.className'), "turbo-sse-retry")
        self.page.wait_for_timeout(200)
        self.assertEqual(len(self.case.requests), 1)
        self.case.status = 200
        self.page.locator(".turbo-sse-retry").click()
        self.text(".turbo-sse-status", "Connected")
        self.case.emit("v", "recovered")
        self.text("#v", "recovered")

    def test_topbar_readouts_activity_lamp_and_unsaved_dot(self):
        self.open('<span id="v" data-sse-event="v" data-sse-json="/x"></span>')
        expect(self.page.locator(".turbo-sse-bar")).to_have_attribute("data-state", "connected")
        # Readouts are small labels before values. Losses and errors appear only once they count something, in yellow.
        counts = self.page.locator(".turbo-sse-counts")
        expect(counts).to_have_text("Captured 0 Evicted 0")
        expect(self.page.locator(".turbo-sse-uptime small")).to_have_text("Uptime")
        self.page.evaluate("""window.pulses = 0; new MutationObserver(r => r.forEach(m => m.target.hasAttribute("data-pulse") && pulses++))
            .observe(document.querySelector(".turbo-sse-status"), {attributes: true})""")
        self.case.emit("v", "{broken")
        self.received(1)
        expect(counts.locator("[data-warn]")).to_have_text("JSON errors 1")
        expect(counts).to_contain_text("Captured 1")
        # The activity lamp in the state tab flashes with incoming events.
        self.page.wait_for_function("pulses > 0")
        # Export All carries a dot while data has not been exported.
        export = self.page.locator(".turbo-sse-export")
        expect(export).to_have_attribute("data-unsaved", "")
        with self.page.expect_download():
            self.page.evaluate("TurboSSE.exportCSV()")
        expect(export).not_to_have_attribute("data-unsaved", "")
        # Jumping needs at least two plots.
        expect(self.page.locator(".turbo-sse-jump")).to_be_hidden()

    def test_topbar_keys_keep_the_right_edge_and_show_their_state(self):
        # Two plots give the topbar both keys; broken JSON and a throwing transform add two error counters.
        self.open('<div data-sse-graph data-sse-event="a"></div><div data-sse-graph data-sse-event="b"></div>'
                  '<span data-sse-event="j" data-sse-json="/x"></span><span data-sse-event="a" data-sse-transform="boom"></span>',
                  functions='window.boom = () => { throw new Error("boom"); };')
        layout = '''() => { const box = s => document.querySelector(s).getBoundingClientRect(), bar = box(".turbo-sse-bar"), jump = box(".turbo-sse-jump"), all = box(".turbo-sse-export");
            const style = getComputedStyle(document.querySelector(".turbo-sse-bar")), counts = box(".turbo-sse-counts");
            return {edge: Math.round(bar.right - parseFloat(style.paddingRight) - all.right), gap: Math.round(all.left - jump.right), row: Math.round(all.top - jump.top),
                    inside: counts.right <= jump.left || counts.bottom <= jump.top, height: Math.round(bar.height), overflow: document.documentElement.scrollWidth > innerWidth}; }'''
        heights = {}
        for errors in (False, True):
            if errors:
                self.case.emit("a", "1"); self.case.emit("j", "{broken"); self.received(2)
                expect(self.page.locator(".turbo-sse-counts [data-warn]")).to_have_count(2)
            for width in (1100, 760, 680, 620, 500, 390):
                self.page.set_viewport_size({"width": width, "height": 600})
                found = self.page.evaluate(layout)
                heights[errors, width] = found.pop("height")
                # Jump and Export All stay together at the right edge, and the counters never run under them.
                self.assertEqual(found, {"edge": 0, "gap": 8, "row": 0, "inside": True, "overflow": False}, (errors, width))
        # The bar is one row while its content fits. Counters that do not fit wrap between the uptime and the keys.
        self.assertEqual([heights[False, 1100], heights[False, 760], heights[True, 1100]], [44, 44, 44], heights)
        self.assertGreater(heights[True, 760], 44, heights)
        self.assertLessEqual(max(heights.values()), 120, heights)
        # A key lights its border under the pointer, takes the selection while pressed and dims while disabled.
        self.page.set_viewport_size({"width": 1100, "height": 600})
        jump, look = self.page.locator(".turbo-sse-jump"), "e => { const s = getComputedStyle(e); return [s.borderTopColor, s.backgroundImage.includes('243, 154, 82')]; }"
        self.page.mouse.move(5, 300)
        self.assertEqual(jump.evaluate(look), ["rgb(108, 108, 108)", False])
        box = jump.bounding_box()
        self.page.mouse.move(box["x"] + 6, box["y"] + 6)
        self.assertEqual(jump.evaluate(look), ["rgb(255, 255, 255)", False])
        self.page.mouse.down()
        self.assertEqual(jump.evaluate(look), ["rgb(243, 154, 82)", True])
        self.page.mouse.up()
        expect(self.page.locator(".turbo-sse-menu")).to_be_visible()
        self.page.keyboard.press("Escape")
        export = self.page.locator(".turbo-sse-export")
        export.evaluate("e => { e.disabled = true; }")
        self.assertEqual(export.evaluate("e => { const s = getComputedStyle(e); return [s.color, s.backgroundImage]; }"), ["rgb(94, 94, 94)", "none"])

    def test_empty_id_resets_native_resume_header(self):
        self.open('<span data-sse-event="v"></span>')
        self.case.emit("v", "a", "boot:1")
        self.case.emit("v", "reset", "")
        self.received(2)
        self.case.disconnect()
        self.wait_requests(2)
        self.assertIsNone(self.case.requests[1]["header"])

    def test_native_parser_handles_multiline_crlf_and_inherited_id(self):
        self.open('<pre id="v" data-sse-event="v"></pre>')
        self.case.wire(b'id: initial\r\nevent: v\r\ndata: first\r\ndata: second\r\n\r\n')
        self.case.wire(b'event: v\ndata: trailing\ndata:\n\n')
        self.received(2)
        rows = self.export()
        self.assertEqual([row["data"] for row in rows], ["first\nsecond", "trailing\n"])
        self.assertEqual([row["last_event_id"] for row in rows], ["initial", "initial"])

    def test_refresh_and_initialization_do_not_duplicate_connections_or_capture(self):
        self.open('<span id="v" data-sse-event="v"></span>')
        self.page.evaluate('for(let i=0;i<5;i++){TurboSSE.init();TurboSSE.refresh();}')
        self.page.add_script_tag(url=self.server.url + "/dist/turbo-sse.min.js")
        self.case.emit("v", "once")
        self.text("#v", "once")
        self.assertEqual(self.stats()["received"], 1)
        self.assertEqual(self.page.locator(".turbo-sse-bar").count(), 1)
        self.assertEqual(len(self.case.requests), 1)
        self.page.evaluate('document.querySelector("#v").remove();TurboSSE.refresh()')
        self.case.emit("v", "still captured")
        self.received(2)
        self.assertEqual(self.export()[-1]["data"], "still captured")

    def test_destroy_cancels_watchdog_restart_and_allows_reinitialization(self):
        self.open('<span data-sse-event="v"></span>', 'data-sse-timeout="100"')
        self.text(".turbo-sse-status", "Stalled")
        self.page.evaluate("TurboSSE.destroy()")
        self.assertIsNone(self.stats())
        self.assertEqual(self.page.locator(".turbo-sse-bar").count(), 0)
        self.page.wait_for_timeout(2200)
        self.assertEqual(len(self.case.requests), 1)
        self.page.evaluate('document.body.setAttribute("data-sse-timeout","0");TurboSSE.init()')
        self.text(".turbo-sse-status", "Connected")
        self.wait_requests(2)

    def test_invalid_binding_configuration_is_visible_and_isolated(self):
        self.open('<span data-sse-event="v" data-sse-json="bad">old</span>'
                  '<span data-sse-event="v" data-sse-json="/~bad">old</span>'
                  '<span data-sse-event="v" data-sse-transform="alert(1)">old</span>'
                  '<span id="good" data-sse-event="v"></span>')
        self.case.emit("v", "healthy")
        self.text("#good", "healthy")
        self.assertEqual(self.stats()["configErrors"], 3)
        expect(self.page.locator(".turbo-sse-counts")).to_contain_text("Config errors 3")

    def test_omission_only_filters_raw_capture(self):
        self.open('<span id="v" data-sse-event="v"></span>'
                  '<span id="bad" data-sse-event="json" data-sse-json="/value">old</span>',
                  'data-sse-omit-raw="v json uptime"')
        self.case.emit("v", "visible", "cursor:1")
        self.case.emit("json", "{broken", "cursor:2")
        self.case.emit("uptime", "12500000", "cursor:3")
        self.case.emit("message", "retained", "cursor:4")
        self.received(4)
        self.text("#v", "visible")
        self.text("#bad", "old")
        self.assertEqual(self.stats()["omitted"], 3)
        self.assertEqual(self.stats()["parseErrors"], 1)
        self.assertEqual(self.stats()["lastEventId"], "cursor:4")
        self.assertGreaterEqual(self.stats()["uptime"], 12.5)
        self.assertEqual([r["data"] for r in self.export()], ["retained"])

    def test_uptime_sync_custom_name_and_validation(self):
        self.open('<span id="v" data-sse-event="tick"></span>', 'data-sse-uptime-event="tick"')
        self.text(".turbo-sse-uptime", "Uptime —")
        self.case.emit("tick", "3661250000")
        self.received(1)
        self.page.wait_for_function("TurboSSE.stats().uptime > 3661.5")
        expect(self.page.locator(".turbo-sse-uptime")).to_contain_text("Uptime ≈01:01:")
        # Only unsigned decimal integers of microseconds are valid.
        for bad in ("", " ", "-1", "+1", "1.5", "1.", "1e6", "Infinity", "NaN", "1seconds", '{"uptime":1}', "0x10"):
            self.case.emit("tick", bad)
        self.received(13)
        self.assertEqual(self.stats()["clockErrors"], 12)
        self.assertEqual(self.stats()["lastUptime"], 3661.25)
        self.case.emit("tick", "3250000")
        self.received(14)
        self.assertEqual(self.stats()["restarts"], 0)
        self.assertEqual(self.stats()["lastUptime"], 3.25)

    def test_restart_uses_first_valid_report_after_reconnect(self):
        self.open("")
        self.case.emit("uptime", "100000000")
        self.received(1)
        self.case.disconnect()
        self.page.wait_for_function("TurboSSE.stats().uptime === null")
        self.wait_requests(2)
        self.text(".turbo-sse-status", "Connected")
        # Until the next report, the uptime is a dash with a small label saying why.
        expect(self.page.locator(".turbo-sse-uptime small")).to_have_text(["Uptime", "unsynchronized"])
        expect(self.page.locator(".turbo-sse-uptime b").first).to_have_text("—")
        self.case.emit("uptime", "invalid")
        self.case.emit("uptime", "2500000")
        self.received(3)
        self.assertEqual(self.stats()["restarts"], 1)
        self.assertEqual(self.stats()["segment"], 1)
        self.case.emit("uptime", "1000000")
        self.received(4)
        self.assertEqual(self.stats()["restarts"], 1)
        self.case.disconnect()
        self.wait_requests(3)
        self.text(".turbo-sse-status", "Connected")
        self.case.emit("uptime", "1000000")
        self.received(5)
        self.assertEqual(self.stats()["restarts"], 1)

    def test_source_asset_and_minified_asset_both_boot(self):
        self.case, url = self.server.add('<span id="v" data-sse-event="v"></span>', asset="src/turbo-sse.js")
        self.page.goto(url)
        self.text(".turbo-sse-status", "Connected")
        self.case.emit("v", "source works")
        self.text("#v", "source works")


for _engine in os.environ.get("TURBO_SSE_BROWSERS", "chromium,firefox,webkit").split(","):
    _name = _engine.strip()
    if _name not in ("chromium", "firefox", "webkit"):
        raise ValueError("Unknown browser: " + _name)
    globals()[_name.capitalize() + "Tests"] = type(_name.capitalize() + "Tests", (BrowserCases, unittest.TestCase), {"ENGINE": _name})
