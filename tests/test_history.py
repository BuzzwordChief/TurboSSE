"""Numerical/reference tests for the production history store, without a public test API."""
import math
import statistics
import unittest

from tests.support import ROOT
from playwright.sync_api import sync_playwright


HISTORY_SOURCE = (ROOT / "src/turbo-sse.js").read_text().replace(
    "  function start(root) {", "  window.TestHistory = History;\n  function start(root) {", 1)


class HistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.add_script_tag(content=HISTORY_SOURCE)

    def tearDown(self):
        self.page.close()

    def test_pressure_preserves_statistics_and_extrema(self):
        values = [float(i % 37) - 18 for i in range(30000)]
        values[311] = 10000
        values[18888] = -8000
        result = self.page.evaluate("""values => {
            const h = new TestHistory(16384);
            let peak = 0;
            values.forEach((v, i) => {h.add(i / 100, i / 100 + 20, v, 0); peak = Math.max(peak, h.bytes);});
            return {a: Array.from(h.range()), bytes: h.bytes, peak, compacted: h.compacted,
                raw: h.raw, evicted: h.evicted, latest: Array.from(h.nearest(299.99).a)};
        }""", values)
        a = result["a"]
        self.assertEqual(a[5], len(values))
        self.assertEqual(a[15], len(values))
        self.assertEqual((a[6], a[7], a[12], a[13]), (-8000, 10000, 188.88, 3.11))
        self.assertAlmostEqual(a[8], statistics.mean(values), places=10)
        self.assertAlmostEqual(a[9] / a[5], statistics.pvariance(values), places=7)
        self.assertEqual(result["evicted"], 0)
        self.assertLessEqual(result["peak"], 16384)
        self.assertGreater(result["compacted"], 0)
        self.assertEqual(result["raw"] + result["compacted"], len(values))
        self.assertEqual(result["latest"][8], values[-1])

    def test_budget_does_not_expire_old_samples_when_they_fit(self):
        result = self.page.evaluate("""() => {
            const h = new TestHistory(1048576);
            for (let i=0;i<1000;i++) h.add(i*3600, NaN, i, 0);
            return {compacted:h.compacted, raw:h.raw, oldest:h.nearest(0).a[8], a:Array.from(h.range(9*3600, 19*3600))};
        }""")
        self.assertEqual(result["compacted"], 0)
        self.assertEqual(result["raw"], 1000)
        self.assertEqual(result["oldest"], 0)
        self.assertEqual(result["a"][5], 11)
        self.assertEqual(result["a"][8], 14)

    def test_gaps_segments_and_duplicate_times(self):
        result = self.page.evaluate("""() => {
            const h = new TestHistory(12000);
            for(let i=0;i<4000;i++) h.add(Math.floor(i/2), i/10, i%7 ? i : NaN, i<2000 ? 0 : 1);
            const rows=[];
            h.query(-Infinity,Infinity,0,(a,coarse)=>rows.push({a:Array.from(a),coarse}));
            return {rows, all:Array.from(h.range()), last:Array.from(h.nearest(1999).a), bytes:h.bytes};
        }""")
        self.assertEqual(result["all"][15], 4000)
        self.assertEqual(result["all"][14], math.ceil(4000 / 7))
        self.assertEqual(result["last"][8], 3999)
        self.assertLessEqual(result["bytes"], 12000)
        self.assertTrue(any(row["coarse"] for row in result["rows"]))
        self.assertTrue(all(row["a"][4] in (0, 1) for row in result["rows"]))
        self.assertEqual(sum(row["a"][15] for row in result["rows"]), 4000)

    def test_snapshot_and_resize_are_independent(self):
        result = self.page.evaluate("""() => {
            const h = new TestHistory(1048576);
            for(let i=0;i<1000;i++) h.add(i,i,i,0);
            const frozen=h.copy();
            h.resize(8192);
            for(let i=1000;i<4000;i++) h.add(i,i,i,0);
            return {snapshot:Array.from(frozen.range()), live:Array.from(h.range()), bytes:h.bytes};
        }""")
        self.assertEqual(result["snapshot"][5], 1000)
        self.assertEqual(result["snapshot"][8], 499.5)
        self.assertEqual(result["live"][5], 4000)
        self.assertEqual(result["live"][8], 1999.5)
        self.assertLessEqual(result["bytes"], 8192)

    def test_pixel_query_uses_index_and_preserves_spike(self):
        result = self.page.evaluate("""() => {
            const h=new TestHistory(8*1024*1024);
            for(let i=0;i<100000;i++) h.add(i/100,NaN,i===23779?12345:Math.sin(i),0);
            let count=0, max=-Infinity;
            h.query(0,1000,800,a=>{count++;max=Math.max(max,a[7]);});
            const narrow=h.range(237.78,237.80);
            return {count,max,narrow:Array.from(narrow),compacted:h.compacted};
        }""")
        self.assertEqual(result["max"], 12345)
        self.assertEqual(result["compacted"], 0)
        self.assertLess(result["count"], 5000)
        self.assertEqual(result["narrow"][5], 3)

    def test_many_restarts_remain_bounded(self):
        result = self.page.evaluate("""() => {
            const h=new TestHistory(8192);
            for(let i=0;i<2000;i++) h.add(i,0,i,i);
            return {bytes:h.bytes, evicted:h.evicted, retained:h.range()[15], last:h.nearest(1999).a[8]};
        }""")
        self.assertLessEqual(result["bytes"], 8192)
        self.assertEqual(result["evicted"] + result["retained"], 2000)
        self.assertEqual(result["last"], 1999)
