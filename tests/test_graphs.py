"""Browser-level graph, shared history, interaction and CSV integration checks."""
import csv
import io
import math
import os
from pathlib import Path
import unittest

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

    def export_files(self, prepare=True):
        if prepare:
            self.page.locator('.turbo-sse-export').click()
        self.page.wait_for_function('document.querySelector(".turbo-sse-export-panel").dataset.state !== "preparing"')
        panel = self.page.locator('.turbo-sse-export-panel')
        self.assertEqual(panel.get_attribute('data-state'), 'ready', panel.inner_text())
        files = {}
        for link in panel.locator('a[download]').all():
            name = link.inner_text()
            with self.page.expect_download() as download:
                link.click()
            data = Path(download.value.path()).read_text(encoding='utf-8')
            files[name] = list(csv.DictReader(io.StringIO(data)))
        return files

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
        self.page.locator('.turbo-sse-export-panel button').click()
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
        self.page.locator('.turbo-sse-export').click()
        for i in range(3000, 3300):
            self.case.emit('v', str(i))
        files = self.export_files(prepare=False)
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
        self.page.mouse.move(box['x'] + 150, box['y'] + 100)
        self.page.mouse.down()
        self.page.mouse.move(box['x'] + box['width'] * .65, box['y'] + 140, steps=5)
        self.page.mouse.up()
        self.page.mouse.move(box['x'] + 400, box['y'] + 110)
        expect(self.page.locator('#a .turbo-sse-readout')).to_contain_text('Elapsed')
        expect(self.page.locator('#a [data-action="Live"]')).to_have_attribute('aria-pressed', 'false')
        expect(self.page.locator('#b [data-action="Live"]')).to_have_attribute('aria-pressed', 'false')
        self.page.mouse.move(1, 1)
        expect(self.page.locator('#a .turbo-sse-readout')).to_contain_text('Inspecting')
        self.page.locator('#a select').select_option('Measure')
        self.page.mouse.move(box['x'] + 170, box['y'] + 100)
        self.page.mouse.down()
        self.page.mouse.move(box['x'] + 550, box['y'] + 100, steps=5)
        self.page.mouse.up()
        expect(self.page.locator('#a .turbo-sse-measure')).to_contain_text('RMS')
        expect(self.page.locator('#b .turbo-sse-measure')).to_contain_text('Δt')
        canvas.focus(); self.page.keyboard.press('Escape'); self.page.keyboard.press('l')
        expect(self.page.locator('#a [data-action="Live"]')).to_have_attribute('aria-pressed', 'true')

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

    def test_closed_export_releases_urls_and_new_snapshot_includes_new_data(self):
        self.open('<div data-sse-graph data-sse-event="v"></div>')
        self.case.emit('v','1');self.received(1)
        first=self.export_files()
        urls=self.page.locator('.turbo-sse-export-panel a').evaluate_all('(els)=>els.map(el=>el.href)')
        self.page.locator('.turbo-sse-export-panel button').click()
        self.assertTrue(self.page.evaluate('async urls=>(await Promise.all(urls.map(u=>fetch(u).then(()=>false,()=>true)))).every(Boolean)',urls))
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
        self.page.locator('.turbo-sse-tools select').select_option('Measure')
        box=self.page.locator('canvas').bounding_box()
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
        self.page.mouse.move(box['x']+170,box['y']+90);self.page.mouse.down()
        self.page.mouse.move(box['x']+650,box['y']+90,steps=5);self.page.mouse.up()
        self.page.locator('#a [data-action="Export view"]').click()
        files=self.export_files(prepare=False)
        self.assertEqual(list(files),['s01-v.csv'])
        self.assertGreater(len(files['s01-v.csv']),0)
        self.assertLess(len(files['s01-v.csv']),16)

    def test_source_asset_graphs_and_uptime_boot_without_build(self):
        self.case,url=self.server.add('<div data-sse-graph data-sse-event="v"></div>',asset='src/turbo-sse.js')
        self.page.goto(url);self.text('.turbo-sse-status','Connected')
        self.case.emit('uptime','123.5');self.case.emit('v','2.5');self.received(2)
        self.assertGreaterEqual(self.stats()['uptime'],123.5)
        self.assertEqual(self.export_files()['s01-v.csv'][0]['value'],'2.5')


for _engine in os.environ.get('TURBO_SSE_BROWSERS', 'chromium,firefox,webkit').split(','):
    _name = _engine.strip()
    globals()[_name.capitalize() + 'GraphTests'] = type(_name.capitalize() + 'GraphTests', (GraphCases, unittest.TestCase), {'ENGINE': _name})
