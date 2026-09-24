**Validation — 24 September 2026**

Implementation, demo, and tests were run with **Python 3.9.6** on an **Apple M4 Pro**, macOS 27.0 (arm64).

**Behavioral checks**

76 tests passed: 23 browser scenarios in each of Chromium 140.0.7339.16, Firefox 141.0, and WebKit 26.0; five SSE-encoding/distribution checks; and two checks of the actual example server/page. Browser automation used Playwright 1.55.0.

The browser tests use real localhost SSE responses and real downloaded CSV files. Coverage includes raw strings, JSON pointers and shared parsing, user transforms, exception isolation, append/capture limits, suspended rendering, native reconnect headers, watchdog resume queries, heartbeat behavior, HTTP 204, refresh, and destruction. The demo was also rendered and visually inspected.

The distribution was rebuilt with rjsmin 1.2.5 and verified with `tools/build.py --check`. Python files passed a Python 3.9 syntax check.

| Asset | Minified bytes | Gzip bytes |
| --- | ---: | ---: |
| `turbo-sse.min.js` | 10,963 | 4,006 |
| `turbo-sse.css` | 837 | 432 |
| Combined | 11,800 | **4,438** |

The combined gzip size is below the 5,120-byte budget. JavaScript source size is 14,689 bytes.

**Sustained-load result**

[Full report](benchmarks/mixed-transform-600s.json): Chromium, 100 value bindings plus an append log, 1,000 messages/second for 600 seconds, mixed raw/JSON values, user transforms enabled, and a two-second pause in render callbacks.

- Sent and received: **600,000 / 600,000**.
- Receive callback: 0.0194 ms mean, 0.1 ms p95.
- Render callback: 0.177 ms mean, **0.4 ms p95**, below the 8 ms target.
- Post-GC JavaScript heap: 2.46–2.58 MB after the first 30 seconds; 2.51 MB at completion.
- Final capture: 10,000 retained records, 507,000 accounted string bytes, and 590,000 expected oldest-record evictions.
- Append log: 500 retained entries and 29,500 expected oldest-entry removals.
- No oversized records, JSON errors, transform errors, or configuration errors.

The raw-string path also has a separate [30-second report](benchmarks/raw-30s.json), with JSON extraction and transforms disabled.

Timings are instrumented JavaScript callback durations; rendering measurements exclude layout and paint. Percentiles use the last 10,000 callbacks, while means cover the whole run. Heap measurements force garbage collection and include the test page and bounded instrumentation arrays, but not browser-native memory or the Python fixture's history. The render pause deterministically withholds animation callbacks; it is not a measurement of browser-specific background-tab throttling. These measurements describe this machine and workload, not a throughput guarantee for every client.

**Distribution fingerprints (SHA-256)**

```text
17b00f90d1926e8e4bf984c142f22343cbf1b636c6b2ce0c415f58d167a8bb6f  dist/turbo-sse.min.js
5afa68396007e12f89b10e328460e0621e5fa3995705ab281644b6f4f9427743  dist/turbo-sse.css
```
