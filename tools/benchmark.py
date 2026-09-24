#!/usr/bin/env python3
"""Benchmark a real SSE stream with Python 3.9; defaults to the planned 10-minute run."""
import argparse
import json
import math
from pathlib import Path
import platform
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.support import FixtureServer
from playwright.sync_api import sync_playwright


INSTRUMENT = r"""
(() => {
  const metrics = window.benchmarkMetrics = {receive: [], flush: [], receiveCount: 0, flushCount: 0, receiveTotal: 0, flushTotal: 0};
  const sample = (kind, duration) => {
    const count = metrics[kind + 'Count']++;
    metrics[kind + 'Total'] += duration;
    metrics[kind][count % 10000] = duration;
  };
  const add = EventSource.prototype.addEventListener;
  const remove = EventSource.prototype.removeEventListener;
  const callbacks = new WeakMap();
  EventSource.prototype.addEventListener = function(type, fn, options) {
    if (!callbacks.has(fn)) callbacks.set(fn, function(event) {
      const start = performance.now();
      try { return fn.call(this, event); }
      finally { sample('receive', performance.now() - start); }
    });
    return add.call(this, type, callbacks.get(fn), options);
  };
  EventSource.prototype.removeEventListener = function(type, fn, options) {
    return remove.call(this, type, callbacks.get(fn) || fn, options);
  };
  const frame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = fn => frame(function run(time) {
    if (window.pauseRendering) return frame(run);
    const start = performance.now();
    try { fn(time); }
    finally { sample('flush', performance.now() - start); }
  });
})();
"""


def summarize(samples):
    if not samples:
        return {"p95_ms": 0, "max_ms": 0}
    values = sorted(samples)
    return {"p95_ms": values[min(len(values) - 1, math.ceil(len(values) * .95) - 1)], "max_ms": values[-1]}


def run(args):
    server = FixtureServer()
    stop = threading.Event()
    sent = [0]
    markup = []
    for index in range(args.bindings):
        is_json = args.mode == "json" or (args.mode == "mixed" and index % 2 == 0)
        markup.append('<span data-sse-event="{}"{}{}>0</span>'.format(
            "json" if is_json else "raw", ' data-sse-json="/value"' if is_json else "",
            ' data-sse-transform="formatValue"' if args.transform else ""))
    markup.append('<pre data-sse-event="log" data-sse-swap="append" data-sse-limit="500"></pre>')
    case, url = server.add("".join(markup), functions="window.formatValue=v=>Number(v).toFixed(2);")

    def produce():
        started = time.monotonic()
        while not stop.is_set():
            elapsed = min(time.monotonic() - started, args.seconds)
            target = int(elapsed * args.rate)
            for _ in range(min(100, target - sent[0])):
                index = sent[0]
                if index % 20 == 0:
                    name, value = "log", "sample {}\n".format(index)
                elif args.mode == "json" or (args.mode == "mixed" and index % 2 == 0):
                    name, value = "json", json.dumps({"value": index}, separators=(",", ":"))
                else:
                    name, value = "raw", str(index)
                case.emit(name, value)
                sent[0] += 1
            if sent[0] >= int(args.seconds * args.rate):
                return
            stop.wait(.005)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            page.add_init_script(INSTRUMENT)
            page.goto(url)
            page.wait_for_function('TurboSSE.stats().state === "Connected"')
            cdp = page.context.new_cdp_session(page)
            heaps = []
            producer = threading.Thread(target=produce, daemon=True)
            started = time.monotonic()
            producer.start()
            next_report = 0
            paused = False
            while time.monotonic() - started < args.seconds:
                elapsed = time.monotonic() - started
                should_pause = args.seconds / 2 <= elapsed < args.seconds / 2 + args.pause_render_seconds
                if should_pause != paused:
                    page.evaluate("value => window.pauseRendering = value", should_pause)
                    paused = should_pause
                if elapsed >= next_report:
                    cdp.send("HeapProfiler.collectGarbage")
                    heap = cdp.send("Runtime.getHeapUsage")["usedSize"]
                    heaps.append({"seconds": round(elapsed, 1), "bytes_after_gc": heap})
                    print("{:.0f}s: sent={}, received={}, heap={} bytes".format(elapsed, sent[0], page.evaluate("TurboSSE.stats().received"), heap), flush=True)
                    next_report += 30
                page.wait_for_timeout(100)
            producer.join(timeout=5)
            page.evaluate("window.pauseRendering = false")
            page.wait_for_function("n => TurboSSE.stats().received >= n", arg=sent[0], timeout=15000)
            page.wait_for_timeout(100)
            cdp.send("HeapProfiler.collectGarbage")
            heaps.append({"seconds": round(time.monotonic() - started, 1), "bytes_after_gc": cdp.send("Runtime.getHeapUsage")["usedSize"]})
            metrics = page.evaluate("benchmarkMetrics")
            stats = page.evaluate("TurboSSE.stats()")
            result = {
                "python": platform.python_version(), "platform": platform.platform(), "machine": platform.machine(),
                "browser": "Chromium " + browser.version, "seconds": args.seconds, "rate": args.rate,
                "bindings": args.bindings, "mode": args.mode, "transform": args.transform,
                "render_pause_seconds": args.pause_render_seconds,
                "payloads": "raw: decimal counter; json: {value: counter}; log: sample counter + newline (5% of messages)",
                "sent": sent[0], "stats": stats, "heap_samples": heaps,
                "receive": dict(summarize(metrics["receive"]), mean_ms=metrics["receiveTotal"] / max(1, metrics["receiveCount"])),
                "flush": dict(summarize(metrics["flush"]), mean_ms=metrics["flushTotal"] / max(1, metrics["flushCount"])),
                "timing_note": "p95/max use the last 10,000 callbacks; means cover the full run. Flush excludes browser layout/paint. Heap samples force GC; fixture storage is outside browser heap.",
            }
            page.evaluate("TurboSSE.destroy()")
            browser.close()
    finally:
        stop.set()
        server.close()
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    if result["sent"] != result["stats"]["received"] or result["flush"]["p95_ms"] >= 8:
        raise SystemExit("Benchmark target not met; inspect the report")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=600)
    parser.add_argument("--rate", type=int, default=1000)
    parser.add_argument("--bindings", type=int, default=100)
    parser.add_argument("--mode", choices=("raw", "mixed", "json"), default="mixed")
    parser.add_argument("--transform", action="store_true")
    parser.add_argument("--pause-render-seconds", type=float, default=2, help="Temporarily withhold rendering callbacks to exercise queue bounds")
    parser.add_argument("--output")
    args = parser.parse_args()
    if not math.isfinite(args.seconds) or args.seconds <= 0 or args.rate < 1 or args.bindings < 1:
        parser.error("Duration, rate, and bindings must be positive")
    if not math.isfinite(args.pause_render_seconds) or not 0 <= args.pause_render_seconds < args.seconds / 2:
        parser.error("Render pause must be nonnegative and less than half the duration")
    run(args)
