#!/usr/bin/env python3
"""Bounded history simulation and real SSE/Canvas soak (Python 3.9+)."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import platform
import sys
import threading
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tests.support import ROOT as TEST_ROOT  # Configures Playwright's local browser cache.
from tools.benchmark import INSTRUMENT, summarize
from playwright.sync_api import sync_playwright


def history(page, args):
    source = (ROOT / 'src/turbo-sse.js').read_text().replace(
        '  function start(root) {', '  window.TestHistory = History;\n  function start(root) {', 1)
    page.add_script_tag(content=source)
    return page.evaluate('''opts => {
        const {channels, rate, seconds, budget} = opts, count = Math.floor(seconds*rate);
        const histories = window.benchHistories = Array.from({length:channels},()=>new TestHistory(Math.floor(budget/channels)));
        const refs = histories.map(()=>({n:0,mean:0,m2:0,min:Infinity,max:-Infinity}));
        const begin = performance.now(); let peak=0;
        for(let i=0;i<count;i++) {
            const t=i/rate;
            for(let j=0;j<channels;j++) {
                const y=i%100003===157 ? 999+j : i%100019===83 ? -499-j : Math.sin(i/20)+j/10;
                histories[j].add(t,t,y,0);
                const r=refs[j], d=y-r.mean; r.n++; r.mean+=d/r.n; r.m2+=d*(y-r.mean); r.min=Math.min(r.min,y); r.max=Math.max(r.max,y);
            }
            if(i%100000===0) peak=Math.max(peak,histories.reduce((n,h)=>n+h.bytes,0));
        }
        const ingestMs=performance.now()-begin;
        const results=histories.map((h,j)=>{
            const a=h.range(), r=refs[j];
            if(a[5]!==r.n || a[6]!==r.min || a[7]!==r.max || Math.abs(a[8]-r.mean)>1e-8 || Math.abs(a[9]*a[9]-r.m2/r.n)>1e-7 || h.evicted) throw Error('Reference mismatch for channel '+j);
            return {count:a[5],min:a[6],max:a[7],mean:a[8],variance:a[9]*a[9],raw:h.raw,compacted:h.compacted,bytes:h.bytes};
        });
        const queries=[], cursors=[]; let maxDrawRecords=0;
        for(let i=0;i<200;i++) {
            const end=seconds*(i+1)/200, start=Math.max(0,end-(i%2?60:seconds));
            let t=performance.now(), records=0;
            for(const h of histories) h.query(start,end,1000,()=>records++);
            queries.push(performance.now()-t);maxDrawRecords=Math.max(maxDrawRecords,records);
            t=performance.now();for(const h of histories) h.nearest(end/2);cursors.push(performance.now()-t);
        }
        return {mode:'history',seconds,rate,channels,values:count*channels,ingest_ms:ingestMs,
            peak_accounted_bytes:peak,series:results,query_ms:queries,cursor_ms:cursors,max_draw_records:maxDrawRecords};
    }''', {'channels': args.channels, 'rate': args.rate, 'seconds': args.seconds, 'budget': args.budget})


class SoakServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, args):
        super().__init__(('127.0.0.1', 0), SoakHandler)
        self.args = args
        self.stop = threading.Event()
        self.sent = self.samples = 0
        self.started = None
        self.done = False
        plots = []
        for i in range(0, args.channels, 2):
            series = ''.join('<span data-sse-event="measure" data-sse-json="/v{}" data-sse-label="Signal {}" data-sse-unit="V"></span>'.format(j,j) for j in range(i,min(i+2,args.channels)))
            plots.append('<div data-sse-graph data-sse-sync="run">'+series+'</div>')
        self.html = ('<!doctype html><link rel="stylesheet" href="/turbo-sse.css"><style>body{{margin:0;--turbo-sse-height:180px}}main{{max-width:1100px;margin:auto}}</style>'
                     '<script defer src="/turbo-sse.min.js"></script><body data-sse-connect="/events" data-sse-graph-bytes="{}"><main>{}</main>'.format(args.budget, ''.join(plots))).encode()
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set(); self.shutdown(); self.server_close(); self.thread.join(timeout=3)


class SoakHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        server = self.server
        if self.path == '/events':
            if server.started is not None:
                self.send_response(204); self.end_headers(); return
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Cache-Control','no-cache'); self.end_headers()
            server.started = time.monotonic()
            tick = 0
            try:
                while not server.stop.is_set() and time.monotonic() - server.started < server.args.seconds:
                    if tick % max(1, server.args.rate) == 0:
                        self.wfile.write(('event: uptime\ndata: {:.6f}\n\n'.format(time.monotonic()-server.started)).encode());server.sent += 1
                    values = {"v"+str(i): round(math.sin(tick/server.args.rate*(i+1)/4)+i/10+(10 if tick%10003==177 else 0),8) for i in range(server.args.channels)}
                    self.wfile.write(('id: sample:{}\nevent: measure\ndata: {}\n\n'.format(tick,json.dumps(values,separators=(',',':')))).encode())
                    self.wfile.flush();server.sent+=1;server.samples+=1;tick+=1
                    server.stop.wait(max(0,server.started+tick/server.args.rate-time.monotonic()))
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                server.done = True
            return
        if self.path == '/':
            body, kind = server.html, 'text/html'
        elif self.path in ('/turbo-sse.min.js','/turbo-sse.css'):
            body=(ROOT/'dist'/self.path[1:]).read_bytes();kind='text/javascript' if self.path.endswith('.js') else 'text/css'
        else:
            self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)


def soak(page, browser, args):
    server=SoakServer(args)
    page.add_init_script(INSTRUMENT)
    page.add_init_script("""(() => {
        window.benchmarkCanvasDraws = 0;
        const clear = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function(...args) {
            window.benchmarkCanvasDraws++;
            return clear.apply(this, args);
        };
    })();""")
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    heaps=[];exports=[];next_report=0;next_export=args.export_every
    try:
        page.goto('http://127.0.0.1:'+str(server.server_port))
        page.wait_for_function('TurboSSE.stats().received>0')
        cdp=page.context.new_cdp_session(page)
        while not server.done:
            elapsed=time.monotonic()-server.started
            if elapsed>=next_report:
                cdp.send('HeapProfiler.collectGarbage')
                heaps.append({'seconds':round(elapsed,2),**cdp.send('Runtime.getHeapUsage')})
                stats=page.evaluate('TurboSSE.stats()')
                print('{:.0f}s: received={} history={} heap={}'.format(elapsed,stats['received'],stats['graphs']['bytes'],heaps[-1]['usedSize']),flush=True)
                next_report+=60
            if args.export_every and elapsed>=next_export:
                before=time.monotonic()
                with page.expect_download(timeout=180000) as download:
                    page.locator('.turbo-sse-export').click()
                with zipfile.ZipFile(download.value.path()) as archive:
                    names=archive.namelist()
                    if archive.testzip() is not None or names[0]!='export.txt':raise RuntimeError('Invalid export ZIP: '+', '.join(names))
                exports.append({'seconds':round(elapsed,2),'duration_ms':round((time.monotonic()-before)*1000,2),'files':sum(n.endswith('.csv') for n in names)})
                next_export+=args.export_every
            page.wait_for_timeout(200)
        page.wait_for_function('n=>TurboSSE.stats().received>=n',arg=server.sent,timeout=30000)
        stats=page.evaluate('TurboSSE.stats()');metrics=page.evaluate('benchmarkMetrics')
        cdp.send('HeapProfiler.collectGarbage');heaps.append({'seconds':round(time.monotonic()-server.started,2),**cdp.send('Runtime.getHeapUsage')})
        interaction = page.evaluate("""async () => {
            const canvas = document.querySelector('canvas'), rect = canvas.getBoundingClientRect();
            const times = [];
            for (let i=0;i<20;i++) {
                const start=performance.now();
                canvas.dispatchEvent(new PointerEvent('pointermove', {clientX:rect.left+100+i*12, clientY:rect.top+60}));
                const synchronous=performance.now()-start;
                const nextFrame=await new Promise(resolve=>requestAnimationFrame(()=>resolve(performance.now()-start)));
                times.push({synchronous, nextFrame});
            }
            return times;
        }""")
        result={'mode':'soak','seconds':args.seconds,'rate':args.rate,'channels':args.channels,'sent':server.sent,'sample_groups':server.samples,'elapsed_seconds':round(time.monotonic()-server.started,3),
                'stats':stats,'errors':errors,'heap_samples':heaps,'exports':exports,
                'canvas_draws':page.evaluate('benchmarkCanvasDraws'),
                'average_draws_per_configured_panel_second':page.evaluate('benchmarkCanvasDraws')/(math.ceil(args.channels/2)*args.seconds),
                'cursor_handler':summarize([t['synchronous'] for t in interaction]),
                'cursor_next_frame':summarize([t['nextFrame'] for t in interaction]),
                'receive':dict(summarize(metrics['receive']),mean_ms=metrics['receiveTotal']/max(1,metrics['receiveCount'])),
                'render':dict(summarize(metrics['flush']),mean_ms=metrics['flushTotal']/max(1,metrics['flushCount']))}
        if any(c.get('samples') != server.samples for c in stats['graphs']['series']):
            raise RuntimeError('A series lost received measurements')
        if errors or stats['received']!=server.sent or stats['graphErrors'] or stats['parseErrors'] or stats['configErrors'] or stats['graphs']['bytes']>args.budget:
            raise RuntimeError('Soak failed: '+json.dumps(result))
        page.evaluate('TurboSSE.destroy()')
        return result
    finally:
        server.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode',choices=('history','soak'),default='history')
    parser.add_argument('--seconds',type=float,default=None)
    parser.add_argument('--rate',type=int,default=100)
    parser.add_argument('--channels',type=int,default=8)
    parser.add_argument('--budget',type=int,default=33554432)
    parser.add_argument('--export-every',type=float,default=600)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    if args.seconds is None: args.seconds = 28800 if args.mode == 'history' else 1800
    if not math.isfinite(args.seconds) or not math.isfinite(args.export_every) or args.export_every < 0 or args.seconds<=0 or args.rate<1 or not 1<=args.channels<=32 or args.budget<args.channels*8192:parser.error('Invalid duration, rate, channels or budget')
    asset=(ROOT/('src/turbo-sse.js' if args.mode=='history' else 'dist/turbo-sse.min.js')).read_bytes()
    with sync_playwright() as p:
        browser=p.chromium.launch();page=browser.new_page(viewport={'width':1280,'height':1200})
        report=history(page,args) if args.mode=='history' else soak(page,browser,args)
        if args.mode=='history':
            cdp=page.context.new_cdp_session(page);cdp.send('HeapProfiler.collectGarbage');report['heap']=cdp.send('Runtime.getHeapUsage')
            report['query']=summarize(report.pop('query_ms'));report['cursor']=summarize(report.pop('cursor_ms'))
        report.update({'browser':browser.version,'python':platform.python_version(),'platform':platform.platform(),'asset_sha256':hashlib.sha256(asset).hexdigest(),
                       'note':'History mode is accelerated production-store ingestion, not wall-clock streaming. Soak is actual SSE/Canvas/export elapsed time. Callback timings exclude paint; heap counters do not describe total process memory.'})
        browser.close()
    out=Path(args.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
