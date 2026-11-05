"""Browser-level graph, shared history, interaction and CSV integration checks."""
import csv
import io
import re
import math
import os
from pathlib import Path
import unittest
import zipfile

from playwright.sync_api import expect
from tests.test_browser import BrowserCases


class GraphCases:
    setUpClass = classmethod(BrowserCases.setUpClass.__func__)
    tearDownClass = classmethod(BrowserCases.tearDownClass.__func__)
    setUp = BrowserCases.setUp
    tearDown = BrowserCases.tearDown
    open = BrowserCases.open
    received = BrowserCases.received
    text = BrowserCases.text
    stats = BrowserCases.stats
    wait_requests = BrowserCases.wait_requests

    def export_files(self, trigger=None):
        """Run an export (Export All by default) and return its CSV rows by file name.

        Every export is one ZIP, downloaded directly: export.txt first, then the CSV files.
        """
        with self.page.expect_download() as download:
            (trigger or self.page.locator('.turbo-sse-export').click)()
        self.assertRegex(download.value.suggested_filename, r'^sse-.+\.zip$')
        with zipfile.ZipFile(Path(download.value.path())) as z:
            self.assertIsNone(z.testzip())
            names = z.namelist()
            self.assertEqual(names[0], 'export.txt')
            self.export_text = z.read('export.txt').decode('utf-8')
            for name in names[1:]:
                self.assertIn('\r\n{} · '.format(name), self.export_text)
                self.assertIn(' · {} bytes'.format(z.getinfo(name).file_size), self.export_text)
            return {name: list(csv.DictReader(io.StringIO(z.read(name).decode('utf-8')))) for name in names[1:]}

    def test_every_export_is_one_zip_with_export_txt(self):
        self.open('<div id="a" data-sse-graph data-sse-event="v" data-sse-label="Volts"></div><div id="b" data-sse-graph data-sse-event="w"></div>')
        for i in range(6):
            self.case.emit('v', str(i)); self.case.emit('w', str(i * 2)); self.page.wait_for_timeout(10)
        self.received(12)
        expect(self.page.locator('.turbo-sse-export')).to_have_text('Export All')
        files = self.export_files()
        self.assertEqual(list(files), ['raw-events.csv', 's01-Volts.csv', 's02-w.csv'])
        self.assertEqual(len(files['raw-events.csv']), 12)
        self.assertIn('All retained data', self.export_text)
        self.assertIn('raw-events.csv · 12 retained original events', self.export_text)
        self.assertEqual(self.page.locator('.turbo-sse-export-panel').count(), 0)
        expect(self.page.locator('.turbo-sse-bar output')).to_have_text('')
        # Export view of one plot also downloads a ZIP, even for its single CSV.
        box = self.page.locator('#a canvas').bounding_box()
        self.page.mouse.click(box['x'] + 200, box['y'] + 100)
        files = self.export_files(self.page.locator('#a [data-action="Export view"]').click)
        self.assertEqual(list(files), ['s01-Volts.csv'])
        self.assertIn('Plot view, elapsed', self.export_text)
        # A failed export reports its reason next to the button and releases it for a retry.
        self.page.evaluate('() => { URL.createObjectURL = () => { throw new Error("Download blocked") }; }')
        self.page.locator('.turbo-sse-export').click()
        expect(self.page.locator('.turbo-sse-bar output')).to_have_text('Download blocked')
        expect(self.page.locator('.turbo-sse-export')).to_be_enabled()

    def raw_rows(self):
        with self.page.expect_download() as download:
            self.page.evaluate('TurboSSE.exportCSV()')
        return list(csv.DictReader(io.StringIO(Path(download.value.path()).read_text(encoding='utf-8'))))

    def test_graph_and_export_preserve_numeric_and_original_values(self):
        self.open('<div id="plot" data-sse-graph data-sse-event="v" data-sse-unit="V" data-sse-label="Voltage"></div>')
        self.case.emit('v', '0012.3456789')
        self.received(1)
        expect(self.page.locator('.turbo-sse-series-value')).to_have_text('12.346 V')
        files = self.export_files()
        self.assertEqual(files['raw-events.csv'][0]['data'], '0012.3456789')
        rows = files['s01-Voltage.csv']
        self.assertEqual(rows[0]['kind'], 'sample')
        self.assertEqual(float(rows[0]['value']), 12.3456789)
        self.assertEqual(rows[0]['count'], '1')
        self.assertEqual(rows[0]['uptime_start_s'], '')
        self.assertEqual(rows[0]['unit'], 'V')
        self.assertEqual(self.stats()['graphs']['plots'], 1)

    def test_omission_does_not_affect_graphs_uptime_or_failed_payloads(self):
        self.open('<div data-sse-graph data-sse-event="v" data-sse-json="/x"></div>',
                  'data-sse-omit-raw="v uptime"')
        self.case.emit('uptime', '50')
        self.case.emit('v', '{"x":5}')
        self.case.emit('v', '{broken')
        self.received(3)
        files = self.export_files()
        self.assertEqual(files['raw-events.csv'], [])
        rows = files['s01-v.csv']
        self.assertEqual([r['kind'] for r in rows], ['sample', 'gap'])
        self.assertGreaterEqual(float(rows[0]['uptime_start_s']), 50)
        self.assertEqual(self.stats()['omitted'], 3)
        self.assertEqual(self.stats()['parseErrors'], 1)

    def test_grouped_and_repeated_series_share_history_and_transform(self):
        self.open('<div id="a" data-sse-graph data-sse-sync="x">'
                  '<span data-sse-event="v" data-sse-json="/x" data-sse-label="X" data-sse-transform="scale" data-sse-unit="V"></span>'
                  '<span data-sse-event="v" data-sse-json="/y" data-sse-label="Y" data-sse-unit="V"></span></div>'
                  '<div id="b" data-sse-graph data-sse-sync="x" data-sse-event="v" data-sse-json="/x" data-sse-transform="scale" data-sse-unit="V"></div>',
                  functions='window.calls=0;window.scale=v=>{calls++;return v*2;};')
        self.case.emit('v', '{"x":2.25,"y":8}')
        self.received(1)
        self.assertEqual(self.page.evaluate('calls'), 1)
        self.assertEqual(len(self.stats()['graphs']['series']), 2)
        self.assertEqual(self.stats()['graphs']['plots'], 2)
        files = self.export_files()
        self.assertEqual(len(files), 3)
        self.assertEqual(float(files['s01-X.csv'][0]['value']), 4.5)
        self.assertEqual(files['s01-X.csv'][0]['transform'], 'scale')
        self.page.evaluate('document.querySelector("#a").remove();TurboSSE.refresh()')
        self.case.emit('v', '{"x":3,"y":9}')
        self.received(2)
        self.assertEqual(len(self.stats()['graphs']['series']), 1)
        self.assertEqual(self.stats()['graphs']['series'][0]['raw'], 2)

    def test_compacted_csv_keeps_counts_spikes_and_weighted_mean(self):
        self.open('<div data-sse-graph data-sse-event="v"></div>', 'data-sse-graph-bytes="16384"')
        values = [float(i % 17) for i in range(6000)]
        values[177] = 9999
        for value in values:
            self.case.emit('v', str(value))
        self.received(len(values))
        state = self.stats()['graphs']
        self.assertLessEqual(state['bytes'], 16384)
        self.assertGreater(state['series'][0]['compacted'], 0)
        rows = self.export_files()['s01-v.csv']
        self.assertTrue(any(r['kind'] == 'summary' for r in rows))
        count = sum(int(r['count']) for r in rows)
        total = sum((float(r['value']) if r['kind'] == 'sample' else float(r['mean'])) * int(r['count']) for r in rows)
        max_value = max(float(r['value']) if r['kind'] == 'sample' else float(r['max']) for r in rows)
        self.assertEqual(count, len(values))
        self.assertAlmostEqual(total / count, sum(values) / count, places=9)
        self.assertEqual(max_value, 9999)
        self.assertTrue(all(r['value'] == '' for r in rows if r['kind'] == 'summary'))

    def test_snapshot_is_consistent_during_reception_and_compaction(self):
        self.open('<div data-sse-graph data-sse-event="v"></div>', 'data-sse-graph-bytes="65536"')
        for i in range(3000):
            self.case.emit('v', str(i))
        self.received(3000)
        def export_while_receiving():
            self.page.locator('.turbo-sse-export').click()
            for i in range(3000, 3300):
                self.case.emit('v', str(i))
        files = self.export_files(export_while_receiving)
        self.assertEqual(len(files['raw-events.csv']), 3000)
        self.assertEqual(sum(int(r['count']) for r in files['s01-v.csv']), 3000)
        self.received(3300)
        self.assertEqual(self.stats()['graphs']['series'][0]['raw'] + self.stats()['graphs']['series'][0]['compacted'], 3300)

    def test_gaps_transform_errors_and_shared_json_parse(self):
        self.open('<div data-sse-graph>'
                  '<span data-sse-event="v" data-sse-json="/x" data-sse-label="X"></span>'
                  '<span data-sse-event="v" data-sse-json="/y" data-sse-label="Y" data-sse-transform="convert"></span></div>'
                  '<pre id="raw" data-sse-event="v"></pre>',
                  functions='window.parses=0;const original=JSON.parse;JSON.parse=(...a)=>{parses++;return original(...a)};window.convert=v=>{if(v===3)throw Error("bad");return v};')
        before = self.page.evaluate('parses')
        for payload in ('{"x":1,"y":2}', '{"x":null,"y":3}', '{"x":"bad","y":4}', '{broken'):
            self.case.emit('v', payload)
        self.received(4)
        self.assertEqual(self.page.evaluate('parses'), before + 4)
        self.assertEqual(self.stats()['transformErrors'], 1)
        self.assertEqual(self.stats()['graphErrors'], 1)
        files = self.export_files()
        self.assertEqual([r['kind'] for r in files['s01-X.csv']], ['sample', 'gap', 'gap', 'gap'])
        self.assertEqual([r['kind'] for r in files['s02-Y.csv']], ['sample', 'gap', 'sample', 'gap'])
        self.assertEqual(len(files['raw-events.csv']), 4)

    def test_refresh_preserves_history_and_destroy_cleans_generated_dom(self):
        self.open('<div id="p" data-sse-graph><span id="source" data-sse-event="v"></span></div>')
        self.case.emit('v', '1')
        self.received(1)
        self.page.evaluate('TurboSSE.refresh();TurboSSE.refresh()')
        self.case.emit('v', '2')
        self.received(2)
        self.assertEqual(self.stats()['graphs']['series'][0]['raw'], 2)
        self.assertEqual(self.page.locator('.turbo-sse-plot').count(), 1)
        self.assertTrue(self.page.locator('#source').evaluate('(el)=>el.hidden'))
        self.page.evaluate('TurboSSE.destroy()')
        self.assertEqual(self.page.locator('.turbo-sse-plot').count(), 0)
        self.assertFalse(self.page.locator('#source').evaluate('(el)=>el.hidden'))
        self.page.evaluate('TurboSSE.init()')
        self.text('.turbo-sse-status', 'Connected')
        self.assertEqual(self.page.locator('.turbo-sse-plot').count(), 1)

    def test_zoom_sync_measure_keyboard_and_live_resume(self):
        self.open('<div id="a" data-sse-graph data-sse-event="v" data-sse-sync="group"></div>'
                  '<div id="b" data-sse-graph data-sse-event="w" data-sse-unit="rpm" data-sse-sync="group"></div>')
        for i in range(12):
            self.case.emit('v', str(i))
            self.case.emit('w', str(i * 100))
            self.page.wait_for_timeout(15)
        self.received(24)
        canvas = self.page.locator('#a canvas')
        box = canvas.bounding_box()
        self.page.mouse.click(box['x'] + 150, box['y'] + 100)  # The first click activates the plot.
        self.page.mouse.down(button='right')
        self.page.mouse.move(box['x'] + box['width'] * .65, box['y'] + 140, steps=5)
        self.page.mouse.up(button='right')
        self.page.mouse.move(box['x'] + 400, box['y'] + 110)
        expect(self.page.locator('#a .turbo-sse-readout')).to_contain_text('Elapsed')
        expect(self.page.locator('#a [data-action="Live"]')).not_to_be_checked()
        expect(self.page.locator('#b [data-action="Live"]')).not_to_be_checked()
        self.page.mouse.move(1, 1)
        expect(self.page.locator('#a .turbo-sse-readout')).to_contain_text('Inspecting')
        self.page.keyboard.down('Shift')
        self.page.mouse.move(box['x'] + 170, box['y'] + 100)
        self.page.mouse.down()
        self.page.mouse.move(box['x'] + 550, box['y'] + 100, steps=5)
        self.page.mouse.up()
        self.page.keyboard.up('Shift')
        expect(self.page.locator('#a .turbo-sse-measure')).to_contain_text('RMS')
        expect(self.page.locator('#b .turbo-sse-measure')).to_contain_text('Δt')
        canvas.focus(); self.page.keyboard.press('Escape'); self.page.keyboard.press('l')
        expect(self.page.locator('#a [data-action="Live"]')).to_be_checked()
        self.page.mouse.move(box['x'] + 300, box['y'] + 100)
        self.page.mouse.wheel(0, 240)
        expect(self.page.locator('#a [data-action="Live"]')).to_be_checked()
        self.page.locator('#a [data-action="Live"]').uncheck()
        expect(self.page.locator('#b [data-action="Live"]')).not_to_be_checked()

    def frames(self):
        # Redraws are capped at about 30 per second (33 ms apart); wait past that, then two frames.
        self.page.evaluate('new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 40))')

    def span(self, plot):
        self.frames()
        text = self.page.locator(plot + ' .turbo-sse-readout').inner_text()
        lo, hi = re.search(r'([-\d.e+]+)–([-\d.e+]+) s', text).groups()
        return float(hi) - float(lo), text

    def test_generated_header_shows_title_and_units(self):
        self.open('<div id="a" data-sse-graph data-sse-title="Thermal response">'
                  '<span data-sse-event="v" data-sse-label="Inlet" data-sse-unit="°C"></span>'
                  '<span data-sse-event="w" data-sse-label="Outlet" data-sse-unit="°C"></span></div>'
                  '<div id="b" data-sse-graph data-sse-event="x" data-sse-label="Motor speed" data-sse-unit="rpm"></div>'
                  '<div id="c" data-sse-graph data-sse-event="y"></div>')
        for plot, title, units in (('#a', 'Thermal response', '°C'), ('#b', 'Motor speed', 'rpm'), ('#c', 'y', '')):
            expect(self.page.locator(plot + ' .turbo-sse-plot > header strong')).to_have_text(title)
            expect(self.page.locator(plot + ' .turbo-sse-plot > header span')).to_have_text(units)
            expect(self.page.locator(plot + ' .turbo-sse-plot')).to_have_attribute('aria-label', title)
        self.page.evaluate('document.querySelector("#a").dataset.sseTitle = "Renamed"; TurboSSE.refresh()')
        expect(self.page.locator('#a .turbo-sse-plot > header strong')).to_have_text('Renamed')

    def test_click_to_activate(self):
        self.open('<div id="a" data-sse-graph data-sse-event="v"></div><div style="height:3000px"></div>')
        for i in range(12):
            self.case.emit('v', str(i)); self.page.wait_for_timeout(15)
        self.received(12)
        plot, tools, canvas = self.page.locator('#a .turbo-sse-plot'), self.page.locator('#a .turbo-sse-tools'), self.page.locator('#a canvas')
        box = canvas.bounding_box()
        hint = 'getComputedStyle(document.querySelector("#a .turbo-sse-tools"), "::before").content'
        # Inactive: hovering asks for a click, tools stay hidden, and the wheel scrolls the page.
        self.page.mouse.move(box['x'] + 300, box['y'] + 100)
        self.assertEqual(self.page.evaluate(hint), '"Click to interact"')
        expect(tools).to_be_hidden()
        expect(self.page.locator('#a [role=toolbar]')).to_be_hidden()
        self.page.mouse.wheel(0, 200)
        self.page.wait_for_function('scrollY > 0')
        self.page.evaluate('scrollTo(0, 0)'); self.page.wait_for_function('scrollY === 0')
        # The first click only activates: tools appear, the message goes, and nothing pans.
        box = canvas.bounding_box()
        self.page.mouse.click(box['x'] + 300, box['y'] + 100)
        expect(plot).to_have_attribute('data-active', '')
        expect(tools).to_be_visible()
        expect(self.page.locator('#a [role=toolbar]')).to_be_visible()
        self.assertEqual(self.page.evaluate(hint), 'none')
        expect(self.page.locator('#a [data-action="Live"]')).to_be_checked()
        # Active: the wheel zooms the plot instead of scrolling the page.
        self.page.evaluate('scrollTo(0, 50)'); self.page.wait_for_function('scrollY === 50')
        box = canvas.bounding_box()
        self.page.mouse.move(1, 1)
        before, _ = self.span('#a')
        self.page.mouse.move(box['x'] + 300, box['y'] + box['height'] / 2)
        self.page.mouse.wheel(0, -200)
        self.page.wait_for_timeout(300)
        self.assertEqual(self.page.evaluate('scrollY'), 50)
        self.page.mouse.move(1, 1)
        after, text = self.span('#a')
        self.assertLess(after, before * .8, text)
        # Clicking elsewhere deactivates the plot again.
        self.page.mouse.click(5, box['y'] + box['height'] + 200)
        expect(plot).not_to_have_attribute('data-active', '')
        expect(tools).to_be_hidden()

    def test_toolbar_clicks_keep_canvas_focus(self):
        self.open('<div id="a" data-sse-graph data-sse-event="v"></div>')
        for i in range(8):
            self.case.emit('v', str(i)); self.page.wait_for_timeout(15)
        self.received(8)
        live, box = self.page.locator('#a [data-action="Live"]'), self.page.locator('#a canvas').bounding_box()
        self.page.mouse.click(box['x'] + 300, box['y'] + 100)
        focused = 'document.activeElement === document.querySelector("#a canvas") && document.querySelector("#a .turbo-sse-plot").hasAttribute("data-active")'
        for control in ('#a label', '#a [data-action="Live"]', '#a [data-action="Fit"]', '#a [data-action="Back"]'):
            self.page.locator(control).click()
            self.assertTrue(self.page.evaluate(focused), control)
        # Shortcuts keep working after a toolbar click.
        checked = live.is_checked()
        self.page.keyboard.press('l')
        expect(live).to_be_checked(checked=not checked)
        # Keyboard users stay on the control they activated (WebKit on macOS does not Tab to buttons).
        if self.ENGINE != 'webkit':
            self.page.keyboard.press('Shift+Tab'); self.page.keyboard.press('Shift+Tab')
            self.assertEqual(self.page.evaluate('document.activeElement.dataset.action'), 'Back')
            self.page.keyboard.press('Enter')
            self.assertEqual(self.page.evaluate('document.activeElement.dataset.action'), 'Back')

    def lane(self, label):
        return next(x for x in self.stats()['graphs']['series'] if x['label'] == label)

    def test_bus_lane_stores_changes_and_draws_values(self):
        self.open('<div id="a" data-sse-graph><span data-sse-event="v" data-sse-unit="V"></span>'
                  '<span data-sse-event="s" data-sse-discrete data-sse-label="State"></span></div>')
        self.page.evaluate("""() => { window.labels = []; const f = CanvasRenderingContext2D.prototype.fillText;
            CanvasRenderingContext2D.prototype.fillText = function (t, ...r) { labels.push(t); return f.call(this, t, ...r); }; }""")
        for i, state in enumerate(['IDLE', 'IDLE', 'RUN', 'RUN', 'RUN', 'FAULT']):
            self.case.emit('v', str(i)); self.case.emit('s', state); self.page.wait_for_timeout(40)
        self.received(12)
        # Repeated values extend the current segment: only the three changes are stored.
        self.assertEqual(self.lane('State')['raw'], 3)
        self.assertEqual(self.stats()['configErrors'], 0)  # A lane may share a panel with a series of any unit.
        entry = self.page.locator('#a .turbo-sse-legend > *').nth(1)
        expect(entry.locator('.turbo-sse-series-value')).to_have_text('FAULT')
        self.assertTrue(entry.evaluate('e => e.style.getPropertyValue("--series-color")').startswith('hsl('))
        self.frames()
        self.assertTrue({'IDLE', 'RUN', 'State'} <= set(self.page.evaluate('labels')), self.page.evaluate('labels'))
        # The plot grows by one lane row, and the measurement block gains a lane table.
        self.assertEqual(self.page.locator('#a .turbo-sse-area').evaluate('e => e.style.height'), 'calc(var(--turbo-sse-height, 220px) + 20px)')
        expect(self.page.locator('#a .turbo-sse-measure table').nth(1).locator('tbody th')).to_have_text('State')
        # A disconnect ends the held value with a gap.
        self.case.disconnect(); self.wait_requests(2); self.text('.turbo-sse-status', 'Connected')
        self.assertEqual(self.lane('State')['raw'], 4)

    def test_lane_values_get_distinct_colors(self):
        self.open('<div id="a" data-sse-graph data-sse-event="s" data-sse-discrete data-sse-label="First"></div>'
                  '<div id="b" data-sse-graph data-sse-event="t" data-sse-discrete data-sse-label="Second"></div>')
        colors = {}
        for plot, event, value in (('#a', 's', 'S2'), ('#a', 's', 'S3'), ('#b', 't', 'S3')):
            self.case.emit(event, value)
            expect(self.page.locator(plot + ' .turbo-sse-series-value')).to_have_text(value)
            colors[plot, value] = self.page.locator(plot + ' .turbo-sse-legend > *').evaluate('e => e.style.getPropertyValue("--series-color")')
        # S2 and S3 hash to the same first color. Sharing a lane, the later value takes its second color;
        # alone in another lane, S3 keeps its first color.
        self.assertNotEqual(colors['#a', 'S2'], colors['#a', 'S3'])
        self.assertEqual(colors['#b', 'S3'], colors['#a', 'S2'])
        self.assertEqual(colors['#a', 'S2'], 'hsl(245,90%,70%)')

    def test_logic_lane_levels_and_invalid_values(self):
        self.open('<div id="p" data-sse-graph data-sse-event="p" data-sse-discrete="logic" data-sse-label="Pump"></div>'
                  '<div id="q" data-sse-graph data-sse-event="q" data-sse-discrete="enum"></div>')
        self.assertEqual(self.stats()['configErrors'], 1)
        for value in ['true', '1', 'off', '0', 'HIGH', '2', 'maybe']:
            self.case.emit('p', value)
        self.received(7)
        # true, off, HIGH and 2 change the level; 1 and 0 repeat it; maybe is not a level and leaves a gap.
        self.assertEqual(self.lane('Pump')['raw'], 4)
        self.assertEqual(self.stats()['graphErrors'], 1)
        expect(self.page.locator('#p .turbo-sse-series-value')).to_have_text('—')

    def test_lane_panel_snaps_markers_measures_and_exports(self):
        self.open('<div id="l" data-sse-graph data-sse-event="s" data-sse-discrete data-sse-label="State"></div>')
        for state in ['A1', 'B2', 'C3', 'B2']:
            self.case.emit('s', state); self.page.wait_for_timeout(300)
        self.received(4)
        # A plot of lanes only has no y axis; its height follows its lanes.
        self.assertEqual(self.page.locator('#l .turbo-sse-area').evaluate('e => e.style.height'), '80px')
        changes = [float(r['elapsed_start_s']) for r in self.export_files()['s01-State.csv'] if r['kind'] == 'value']
        self.assertEqual(len(changes), 4)
        canvas = self.page.locator('#l canvas'); box = canvas.bounding_box()
        self.page.mouse.click(box['x'] + box['width'] / 2, box['y'] + 50)
        self.page.keyboard.press('l'); self.page.keyboard.press('f'); self.page.mouse.move(1, 1)
        span, _ = self.span('#l')
        lo = float(re.search(r'([-\d.e+]+)–', self.page.locator('#l .turbo-sse-readout').inner_text()).group(1))
        left = int(self.page.locator('#l .turbo-sse-tools').evaluate('e => e.style.left')[:-2]) - 2
        width = self.page.evaluate('document.querySelector("#l canvas").clientWidth') - left - 16
        top = self.page.evaluate('document.querySelector("#l .turbo-sse-tools").offsetHeight') + 6
        x = lambda t: box['x'] + left + (t - lo) / span * width
        # Markers placed within 5 px of a change over the lane stick to it.
        self.page.mouse.move(x(changes[1]) + 3, box['y'] + top + 24); self.page.keyboard.press('a')
        self.page.mouse.move(x(changes[3]) - 3, box['y'] + top + 24); self.page.keyboard.press('b')
        self.frames()
        first = self.page.locator('#l .turbo-sse-measure p').inner_text()
        a, b = map(float, re.match(r'A ([-\d.e+]+) s · B ([-\d.e+]+) s', first).groups())
        self.assertAlmostEqual(a, changes[1], places=3); self.assertAlmostEqual(b, changes[3], places=3)
        cells = self.page.locator('#l .turbo-sse-measure tbody td').all_inner_texts()
        self.assertEqual(cells[:4], ['B2', 'B2', '2', '2'], cells)  # At A, at B, changes, distinct values
        # Export view covers A to B and starts with the value held at A.
        rows = self.export_files(self.page.locator('#l [data-action="Export view"]').click)['s01-State.csv']
        self.assertEqual([r['value'] for r in rows if r['kind'] == 'value'], ['B2', 'C3', 'B2'])
        self.assertIn('bus lane', self.export_text)

    def test_cut_off_key_legend_fades_and_shows_in_full_on_hover(self):
        self.open('<div id="n" data-sse-graph data-sse-event="v" style="width:520px"></div>'
                  '<div id="w" data-sse-graph data-sse-event="v" style="width:1100px"></div>')
        self.case.emit('v', '1'); self.received(1)
        narrow, wide = self.page.locator('#n .turbo-sse-tools > span'), self.page.locator('#w .turbo-sse-tools > span')
        full = self.page.locator('#n .turbo-sse-hint + .turbo-sse-hint')
        box = self.page.locator('#n canvas').bounding_box()
        self.page.mouse.click(box['x'] + 300, box['y'] + 120)
        # A legend that does not fit is cut off and fades out; a legend that fits shows plainly.
        expect(narrow).to_have_attribute('data-more', '')
        expect(wide).not_to_have_attribute('data-more', '')
        self.assertNotEqual(narrow.evaluate('e => getComputedStyle(e).maskImage'), 'none')
        expect(full).to_be_hidden()
        self.assertEqual(full.get_attribute('aria-hidden'), 'true')
        height = self.page.evaluate('document.querySelector("#n .turbo-sse-tools").offsetHeight')
        # Hovering shows the full legend over the plot without changing the band.
        legend = self.page.locator('#n .turbo-sse-hint').first.bounding_box()
        self.page.mouse.move(legend['x'] + 40, legend['y'] + legend['height'] / 2)
        expect(full).to_be_visible()
        self.assertGreater(full.bounding_box()['height'], legend['height'])
        # The full legend lies above the toolbar, whose masked icons would otherwise show through it.
        self.assertEqual(full.evaluate('e => getComputedStyle(e).zIndex'), '1')
        self.assertEqual(self.page.evaluate('document.querySelector("#n .turbo-sse-tools").offsetHeight'), height)
        self.page.mouse.move(box['x'] + 300, box['y'] + 150)
        expect(full).to_be_hidden()

    def test_enlarged_plot_fills_the_window_and_follows_history(self):
        self.open('<p>Before</p><div id="a" data-sse-graph data-sse-event="v"></div><div id="b" data-sse-graph data-sse-event="w"></div>'
                  '<div id="l" data-sse-graph data-sse-event="s" data-sse-discrete></div><div style="height:2000px"></div>')
        for i in range(8):
            self.case.emit('v', str(i)); self.case.emit('w', str(i)); self.case.emit('s', 'S' + str(i % 2)); self.page.wait_for_timeout(15)
        self.received(24)
        plot, button = self.page.locator('#b .turbo-sse-plot'), self.page.locator('#b .turbo-sse-plot > header button')
        box = '''id => { const r = document.querySelector(id + " .turbo-sse-plot").getBoundingClientRect(), bar = document.querySelector(".turbo-sse-bar").getBoundingClientRect();
            const box = {top: r.top - bar.bottom, left: r.left, right: document.documentElement.clientWidth - r.right, bottom: innerHeight - r.bottom,
                    canvas: document.querySelector(id + " canvas").clientHeight, page: document.documentElement.scrollHeight, y: scrollY};
            for (const key in box) box[key] = Math.round(box[key]);
            return box; }'''
        self.page.evaluate('scrollTo(0, 150)')
        small = self.page.evaluate(box, '#b')
        expect(button).to_have_text('EnlargeE')
        button.click()
        expect(plot).to_have_attribute('data-max', '')
        expect(button).to_have_text('ReduceE')
        self.frames()
        big = self.page.evaluate(box, '#b')
        # The plot fills the window below the topbar, and its plot area takes the spare height.
        self.assertEqual([big[edge] for edge in ('top', 'left', 'right', 'bottom')], [0, 0, 0, 0], big)
        self.assertGreater(big['canvas'], small['canvas'] * 1.5, big)
        # The page behind keeps its height and scroll position and does not scroll; the other plots are out of reach.
        self.assertEqual((big['page'], big['y']), (small['page'], small['y']))
        self.assertEqual(self.page.evaluate('getComputedStyle(document.documentElement).overflowY'), 'hidden')
        expect(self.page.locator('#a .turbo-sse-plot')).to_be_hidden()
        # The browser's Back button returns to the page, and Forward enlarges the plot again.
        self.assertEqual(self.page.evaluate('history.state.turboSSE'), 2)
        self.page.evaluate('history.back()')
        expect(plot).not_to_have_attribute('data-max', '')
        expect(button).to_have_text('EnlargeE')
        expect(self.page.locator('#a .turbo-sse-plot')).to_be_visible()
        self.frames()
        self.assertEqual(self.page.evaluate(box, '#b'), small)
        self.page.evaluate('history.forward()')
        expect(plot).to_have_attribute('data-max', '')
        # Esc first clears the markers and then leaves the enlarged view; E enlarges and returns.
        self.page.keyboard.press('a'); self.page.keyboard.press('Escape')
        expect(self.page.locator('#b .turbo-sse-selection')).to_be_hidden()
        expect(plot).to_have_attribute('data-max', '')
        self.page.keyboard.press('Escape')
        expect(plot).not_to_have_attribute('data-max', '')
        self.page.keyboard.press('e')
        expect(plot).to_have_attribute('data-max', '')
        # A refresh keeps the plot enlarged; the button returns to the page.
        self.page.evaluate('TurboSSE.refresh()')
        expect(plot).to_have_attribute('data-max', '')
        button.click()
        expect(plot).not_to_have_attribute('data-max', '')
        # A plot of lanes only fills the window too, but keeps the height of its lanes.
        self.page.locator('#l .turbo-sse-plot > header button').click()
        expect(self.page.locator('#l .turbo-sse-plot')).to_have_attribute('data-max', '')
        self.frames()
        lanes = self.page.evaluate(box, '#l')
        self.assertEqual((lanes['canvas'], lanes['bottom']), (80, 0), lanes)
        # Destroying the runtime while a plot is enlarged leaves the page as it was.
        self.page.evaluate('TurboSSE.destroy()')
        self.assertEqual(self.page.evaluate('[document.querySelector("#l").style.minHeight, getComputedStyle(document.documentElement).overflowY]'), ['', 'visible'])

    def test_leaving_with_unsaved_data_asks_first(self):
        self.open('<div id="a" data-sse-graph data-sse-event="v"></div>')
        asks = '''() => { const e = new Event("beforeunload", {cancelable: true}); dispatchEvent(e); return e.defaultPrevented; }'''
        self.assertFalse(self.page.evaluate(asks))  # Nothing has been received yet.
        self.case.emit('v', '1'); self.received(1)
        self.assertTrue(self.page.evaluate(asks))
        # Export view saves one plot's interval only; Export All saves everything received so far.
        box = self.page.locator('#a canvas').bounding_box()
        self.page.mouse.click(box['x'] + 200, box['y'] + 100)
        self.export_files(self.page.locator('#a [data-action="Export view"]').click)
        self.assertTrue(self.page.evaluate(asks))
        self.export_files()
        self.assertFalse(self.page.evaluate(asks))
        self.case.emit('v', '2'); self.received(2)
        self.assertTrue(self.page.evaluate(asks))
        self.raw_rows()
        self.assertFalse(self.page.evaluate(asks))
        self.case.emit('v', '3'); self.received(3)
        self.page.evaluate('TurboSSE.destroy()')
        self.assertFalse(self.page.evaluate(asks))

    def test_measuring_keeps_the_page_layout(self):
        self.open('<div id="a" data-sse-graph data-sse-sync="s"><span data-sse-event="v"></span><span data-sse-event="w"></span></div>'
                  '<div id="b" data-sse-graph data-sse-sync="s" data-sse-event="x"></div><p id="after">After</p>')
        for i in range(12):
            self.case.emit('v', str(i)); self.case.emit('w', str(i)); self.case.emit('x', str(i)); self.page.wait_for_timeout(10)
        self.received(36)
        layout = '[...document.querySelectorAll("#b, #after, #a .turbo-sse-measure tr")].map(e => Math.round(e.getBoundingClientRect().top))'
        # Idle: the A/B line prompts for a measurement, and each series already has its table row.
        expect(self.page.locator('#a .turbo-sse-measure p')).to_contain_text('Shift-drag')
        self.assertEqual(self.page.locator('#a .turbo-sse-measure tbody tr').count(), 2)
        before = self.page.evaluate(layout)
        box = self.page.locator('#a canvas').bounding_box()
        self.page.mouse.click(box['x'] + 300, box['y'] + 100)
        self.page.keyboard.down('Shift'); self.page.mouse.move(box['x'] + 150, box['y'] + 100); self.page.mouse.down()
        self.page.mouse.move(box['x'] + 500, box['y'] + 100, steps=5); self.page.mouse.up(); self.page.keyboard.up('Shift')
        expect(self.page.locator('#b .turbo-sse-measure')).to_contain_text('RMS')
        self.frames()
        self.assertEqual(self.page.evaluate(layout), before)

    def test_marker_labels_text_selection_and_shortcuts_after_clicks(self):
        self.open('<div id="a" data-sse-graph data-sse-event="v" data-sse-label="Volts" data-sse-unit="V"></div>')
        for i in range(12):
            self.case.emit('v', str(i)); self.page.wait_for_timeout(15)
        self.received(12)
        live, plot, canvas = self.page.locator('#a [data-action="Live"]'), self.page.locator('#a .turbo-sse-plot'), self.page.locator('#a canvas')
        measure, legend = self.page.locator('#a .turbo-sse-measure'), self.page.locator('#a .turbo-sse-legend > *')
        self.page.evaluate("""window.labels = []; const f = CanvasRenderingContext2D.prototype.fillText;
            CanvasRenderingContext2D.prototype.fillText = function (t, ...r) { labels.push(t); return f.call(this, t, ...r); };
            addEventListener('keydown', e => { window.prevented = e.defaultPrevented; })""")
        box = canvas.bounding_box()
        self.page.mouse.click(box['x'] + 300, box['y'] + 100)
        # Measure right to left: B lies left of A, both are labelled, and the first row names each marker's own time.
        self.page.keyboard.down('Shift'); self.page.mouse.move(box['x'] + 600, box['y'] + 100); self.page.mouse.down()
        self.page.mouse.move(box['x'] + 200, box['y'] + 100, steps=5); self.page.mouse.up(); self.page.keyboard.up('Shift')
        expect(measure).to_contain_text('RMS')
        self.page.evaluate('labels = []'); self.case.emit('v', '5'); self.received(13); self.frames()
        self.assertTrue({'A', 'B'} <= set(self.page.evaluate('labels')), self.page.evaluate('labels'))
        a, b = map(float, re.match(r'A ([-\d.e+]+) s · B ([-\d.e+]+) s', measure.locator('p').first.inner_text()).groups())
        self.assertGreater(a, b)
        # Measurement, readout and legend text can be selected, and the selection survives redraws.
        # Drags start inside the text: Firefox does not start a selection on the legend's color swatch.
        for target in (measure.locator('p').first, self.page.locator('#a .turbo-sse-readout'), legend.first):
            r = target.bounding_box()
            self.page.mouse.move(r['x'] + 16, r['y'] + r['height'] / 2); self.page.mouse.down()
            self.page.mouse.move(r['x'] + min(r['width'] - 2, 200), r['y'] + r['height'] / 2, steps=6); self.page.mouse.up()
            self.case.emit('v', '6'); self.frames()
            selected = self.page.evaluate('getSelection().toString()')
            self.assertGreater(len(selected.strip()), 3, target)
            self.assertIn(selected.strip(), target.inner_text())
        expect(legend.first).to_have_attribute('aria-pressed', 'true')
        # Clicks outside the canvas keep the plot active, and its shortcuts keep working.
        for target in (self.page.locator('#a .turbo-sse-readout'), measure.locator('p').first):
            target.click()
            expect(plot).to_have_attribute('data-active', '')
            was = live.is_checked(); self.page.keyboard.press('l'); expect(live).to_be_checked(checked=not was)
        # Legend entries toggle by click and by keyboard; browser shortcuts with modifiers pass through.
        legend.first.click(); expect(legend.first).to_have_attribute('aria-pressed', 'false')
        self.page.keyboard.press('Enter'); expect(legend.first).to_have_attribute('aria-pressed', 'true')
        self.page.keyboard.press('l'); self.assertTrue(self.page.evaluate('prevented'))
        self.frames(); was = live.is_checked()
        self.page.keyboard.press('Control+l'); self.assertFalse(self.page.evaluate('prevented'))
        self.frames(); self.assertEqual(live.is_checked(), was)

    def test_live_toggle_fit_zoom_band_and_reserved_controls(self):
        self.open('<div id="a" data-sse-graph data-sse-event="v"></div>')
        for i in range(12):
            self.case.emit('v', str(i)); self.page.wait_for_timeout(15)
        self.received(12)
        live, canvas = self.page.locator('#a [data-action="Live"]'), self.page.locator('#a canvas')
        box = canvas.bounding_box()
        # Controls sit in a reserved band above the plot, never over data.
        self.page.mouse.click(box['x'] + 300, box['y'] + box['height'] / 2)
        self.assertLessEqual(self.page.evaluate('(() => { const t = document.querySelector("#a .turbo-sse-tools"); return t.offsetTop + t.offsetHeight; })()'),
                             self.page.evaluate('parseFloat(document.querySelector("#a .turbo-sse-cursor").style.top)'))
        # Fit is a one-time action that keeps Live; L toggles Live off and on.
        self.page.locator('#a [data-action="Fit"]').click()
        expect(live).to_be_checked()
        canvas.focus(); self.page.keyboard.press('l')
        expect(live).not_to_be_checked()
        # Re-enabling Live keeps the zoomed span.
        self.page.keyboard.press('+'); self.page.keyboard.press('+')
        self.page.mouse.move(1, 1)
        before, _ = self.span('#a')
        live.check()
        self.page.mouse.move(1, 1)
        expect(self.page.locator('#a .turbo-sse-readout')).to_contain_text('Live')
        after, text = self.span('#a')
        self.assertAlmostEqual(after, before, delta=before * .02, msg=text)
        # The right-drag zoom band stays visible while the pointer rests and data arrives.
        self.page.mouse.move(box['x'] + 150, box['y'] + 100)
        self.page.mouse.down(button='right')
        self.page.mouse.move(box['x'] + 400, box['y'] + 100, steps=4)
        self.case.emit('v', '5'); self.received(13); self.page.wait_for_timeout(150)
        expect(self.page.locator('#a .turbo-sse-selection')).to_be_visible()
        expect(self.page.locator('#a .turbo-sse-selection')).to_have_attribute('data-zoom', '')
        self.page.mouse.up(button='right')
        expect(self.page.locator('#a .turbo-sse-selection')).to_be_hidden()

    def pointer_y(self):
        self.frames()
        text = self.page.locator('#a .turbo-sse-readout').inner_text()
        return float(re.search(r'· y ([-\d.e+]+)', text).group(1)), text

    def test_markers_stop_live_and_fit_resets_y_zoom(self):
        self.open('<div id="a" data-sse-graph data-sse-event="v"></div>')
        for i in range(12):
            self.case.emit('v', str(i)); self.page.wait_for_timeout(15)
        self.received(12)
        live, canvas, selection = self.page.locator('#a [data-action="Live"]'), self.page.locator('#a canvas'), self.page.locator('#a .turbo-sse-selection')
        box = canvas.bounding_box()
        spot = (box['x'] + 300, box['y'] + box['height'] / 2)
        self.page.mouse.click(*spot)
        expect(live).to_be_checked()
        # Placing marker A stops Live, like a measure drag; the marker band is not a zoom band.
        self.page.keyboard.press('a')
        expect(live).not_to_be_checked()
        expect(selection).to_be_visible()
        expect(selection).not_to_have_attribute('data-zoom', '')
        self.page.keyboard.press('Escape')
        # Fit shows everything; Shift with right-drag zooms y; Fit again restores the automatic y range.
        self.page.keyboard.press('f'); self.frames()
        self.page.mouse.move(*spot); fitted, _ = self.pointer_y()
        self.page.keyboard.down('Shift')
        self.page.mouse.move(box['x'] + 100, box['y'] + 60); self.page.mouse.down(button='right')
        self.page.mouse.move(box['x'] + 600, box['y'] + 150, steps=5); self.page.mouse.up(button='right')
        self.page.keyboard.up('Shift')
        self.page.keyboard.press('f'); self.frames()
        self.page.mouse.move(*spot); refitted, text = self.pointer_y()
        self.assertAlmostEqual(refitted, fitted, delta=abs(fitted) * .01 + 1e-9, msg=text)
        self.page.keyboard.down('Shift')
        self.page.mouse.move(box['x'] + 100, box['y'] + 60); self.page.mouse.down(button='right')
        self.page.mouse.move(box['x'] + 600, box['y'] + 150, steps=5); self.page.mouse.up(button='right')
        self.page.keyboard.up('Shift'); self.frames()
        self.page.mouse.move(*spot); zoomed, text = self.pointer_y()
        self.assertNotAlmostEqual(zoomed, fitted, delta=abs(fitted) * .01 + 1e-9, msg=text)
        self.assertEqual(self.page.locator('#a .turbo-sse-tools button').all_inner_texts(), ['FitF', 'Back', 'Export view'])

    def test_restart_rows_and_unsynchronized_times(self):
        self.open('<div data-sse-graph data-sse-event="v"></div>')
        self.case.emit('v', '1'); self.case.emit('uptime', '100'); self.case.emit('v', '2')
        self.received(3)
        self.case.disconnect(); self.wait_requests(2); self.text('.turbo-sse-status', 'Connected')
        self.case.emit('v', '3'); self.case.emit('uptime', '2'); self.case.emit('v', '4')
        self.received(6)
        rows = self.export_files()['s01-v.csv']
        points = [r for r in rows if r['kind'] == 'sample']
        self.assertEqual([r['value'] for r in points], ['1', '2', '3', '4'])
        self.assertEqual(points[0]['uptime_start_s'], '')
        self.assertEqual(points[2]['uptime_start_s'], '')
        self.assertGreaterEqual(float(points[1]['uptime_start_s']), 100)
        self.assertGreaterEqual(float(points[3]['uptime_start_s']), 2)
        self.assertEqual(points[3]['segment'], '1')
        self.assertEqual(len([r for r in rows if r['kind'] == 'restart']), 1)
        self.assertTrue(any(r['kind'] == 'gap' for r in rows))

    def test_resize_hidden_graph_and_configuration_errors_are_isolated(self):
        self.open('<div id="hidden" style="display:none" data-sse-graph data-sse-event="v"></div>'
                  '<div data-sse-graph><span data-sse-event="v" data-sse-unit="V"></span>'
                  '<span data-sse-event="v" data-sse-unit="rpm"></span></div>'
                  '<span id="plain" data-sse-event="v"></span>')
        self.case.emit('v', '12'); self.received(1)
        self.text('#plain', '12')
        self.assertEqual(self.stats()['configErrors'], 1)
        self.page.evaluate('document.querySelector("#hidden").style.display="block"')
        self.page.set_viewport_size({'width': 430, 'height': 800})
        self.page.wait_for_function('document.querySelector("#hidden canvas").width > 300')
        expect(self.page.locator('#hidden .turbo-sse-series-value')).to_have_text('12')
        self.assertEqual(self.stats()['graphErrors'], 0)

    def test_label_refresh_keeps_samples_and_updates_export_metadata(self):
        self.open('<div id="plot" data-sse-graph><span id="source" data-sse-event="v" data-sse-label="Old"></span></div>')
        self.case.emit('v','1');self.received(1)
        self.page.evaluate('document.querySelector("#source").setAttribute("data-sse-label","New");TurboSSE.refresh()')
        expect(self.page.locator('.turbo-sse-series-name')).to_have_text('New')
        self.assertEqual(self.stats()['graphs']['series'][0]['samples'],1)
        self.assertEqual(self.export_files()['s01-New.csv'][0]['series'],'New')

    def test_extreme_values_produce_finite_canvas_coordinates(self):
        self.open('<div data-sse-graph data-sse-event="big"></div><div data-sse-graph data-sse-event="tiny"></div>',
                  functions='window.badCoordinates=0;for(const name of ["moveTo","lineTo","fillRect"]){const fn=CanvasRenderingContext2D.prototype[name];CanvasRenderingContext2D.prototype[name]=function(...args){if(args.some(v=>!Number.isFinite(v)))badCoordinates++;return fn.apply(this,args);};}')
        for value in ('1e308','-1e308','1.7976931348623157e308'):
            self.case.emit('big',value)
        for value in ('1e-300','-1e-300'):
            self.case.emit('tiny',value)
        self.received(5)
        self.page.wait_for_timeout(100)
        self.assertEqual(self.page.evaluate('badCoordinates'),0)
        self.assertEqual(self.stats()['graphErrors'],0)
        files=self.export_files()
        self.assertEqual(float(files['s01-big.csv'][2]['value']),1.7976931348623157e308)
        self.assertEqual(float(files['s02-tiny.csv'][0]['value']),1e-300)

    def test_incompatible_bounds_do_not_break_raw_capture(self):
        self.open('<div data-sse-graph data-sse-event="v" data-sse-y-min="3" data-sse-y-max="2"></div><span id="plain" data-sse-event="v"></span>')
        self.case.emit('v','7');self.received(1)
        self.text('#plain','7')
        self.assertEqual(self.stats()['configErrors'],1)
        self.assertEqual(self.stats()['graphs']['plots'],0)
        self.assertEqual(self.raw_rows()[0]['data'],'7')

    def test_new_snapshot_includes_new_data(self):
        self.open('<div data-sse-graph data-sse-event="v"></div>')
        self.case.emit('v','1');self.received(1)
        first=self.export_files()
        self.case.emit('v','2');self.received(2)
        second=self.export_files()
        self.assertEqual(len(first['s01-v.csv']),1)
        self.assertEqual(len(second['s01-v.csv']),2)

    def test_touch_measurement_and_visible_first_marker(self):
        self.context.close()
        self.context=self.browser.new_context(has_touch=True,viewport={'width':600,'height':800},accept_downloads=True)
        self.page=self.context.new_page();self.page.set_default_timeout(7000)
        self.page.on('pageerror',lambda error:self.errors.append(str(error)))
        self.open('<div data-sse-graph data-sse-event="v"></div>')
        for i in range(8):
            self.case.emit('v',str(i));self.page.wait_for_timeout(15)
        self.received(8)
        box=self.page.locator('canvas').bounding_box()
        self.page.touchscreen.tap(box['x']+300,box['y']+90)  # The first tap activates the plot.
        self.page.touchscreen.tap(box['x']+120,box['y']+90)
        expect(self.page.locator('.turbo-sse-selection')).to_be_visible()
        self.page.touchscreen.tap(box['x']+400,box['y']+100)
        expect(self.page.locator('.turbo-sse-measure')).to_contain_text('Δt')
        expect(self.page.locator('.turbo-sse-measure')).to_contain_text('mean')

    def test_selected_view_exports_only_its_series_and_interval(self):
        self.open('<div id="a" data-sse-graph data-sse-event="v"></div><div data-sse-graph data-sse-event="w"></div>')
        for i in range(16):
            self.case.emit('v',str(i));self.case.emit('w',str(i));self.page.wait_for_timeout(12)
        self.received(32)
        box=self.page.locator('#a canvas').bounding_box()
        self.page.mouse.click(box['x']+170,box['y']+90);self.page.mouse.down(button='right')
        self.page.mouse.move(box['x']+650,box['y']+90,steps=5);self.page.mouse.up(button='right')
        files=self.export_files(self.page.locator('#a [data-action="Export view"]').click)
        self.assertEqual(list(files),['s01-v.csv'])
        self.assertGreater(len(files['s01-v.csv']),0)
        self.assertLess(len(files['s01-v.csv']),16)

    def test_source_asset_graphs_and_uptime_boot_without_build(self):
        self.case,url=self.server.add('<div data-sse-graph data-sse-event="v"></div>',asset='src/turbo-sse.js')
        self.page.goto(url);self.text('.turbo-sse-status','Connected')
        self.case.emit('uptime','123.5');self.case.emit('v','2.5');self.received(2)
        self.assertGreaterEqual(self.stats()['uptime'],123.5)
        self.assertEqual(self.export_files()['s01-v.csv'][0]['value'],'2.5')

    def test_busy_channel_can_use_idle_channels_memory(self):
        self.open(''.join('<div data-sse-graph data-sse-event="v{}"></div>'.format(i) for i in range(4)),
                  'data-sse-graph-bytes="65536"')
        for i in range(1000):self.case.emit('v0',str(i))
        self.received(1000)
        self.assertEqual(self.stats()['graphs']['series'][0]['compacted'],0)
        for i in range(1000,7000):self.case.emit('v0',str(i))
        self.received(7000)
        for j in range(1,4):
            for i in range(400):self.case.emit('v'+str(j),str(i))
        self.received(8200)
        g=self.stats()['graphs']
        self.assertLessEqual(g['bytes'],65536)
        self.assertEqual([c['samples'] for c in g['series']],[7000,400,400,400])
        self.assertEqual(self.stats()['graphErrors'],0)
        self.assertEqual(self.stats()['transformErrors'],0)

    def test_resize_with_selection_updates_offscreen_panels_without_overflow(self):
        self.open(''.join('<div id="p{}" data-sse-graph data-sse-sync="x" data-sse-event="v"></div>'.format(i) for i in range(4)))
        for i in range(8):
            self.case.emit('v',str(i));self.page.wait_for_timeout(15)
        self.received(8)
        self.page.locator('#p0 canvas').focus()
        self.page.keyboard.press('a');self.page.keyboard.press('ArrowRight');self.page.keyboard.press('b')
        self.page.set_viewport_size({'width':390,'height':500})
        self.page.wait_for_function('Array.from(document.querySelectorAll("canvas")).every(c=>Math.abs(c.width-c.clientWidth*devicePixelRatio)<2)')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),390)
        expect(self.page.locator('#p3 .turbo-sse-readout')).not_to_have_text('Waiting for data')


for _engine in os.environ.get('TURBO_SSE_BROWSERS', 'chromium,firefox,webkit').split(','):
    _name = _engine.strip()
    globals()[_name.capitalize() + 'GraphTests'] = type(_name.capitalize() + 'GraphTests', (GraphCases, unittest.TestCase), {'ENGINE': _name})
