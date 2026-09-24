**TurboSSE**

A small, dependency-free JavaScript library for embedded-device debug pages. Bind SSE events to HTML attributes, replace values or append logs, apply your own transforms, and export original message payloads as CSV. A sticky topbar shows connection status and reconnects automatically after recoverable stream failures.

Build the runtime into `dist/turbo-sse.min.js` and `dist/turbo-sse.css`, or download the GitHub Actions artifact. Copy both files onto your device. No Node.js, bundler, CDN, or Python is needed on the device. Readable sources are in `src/`; Python 3.9 is used for the example server, build tooling, and tests. Generated `dist/` files are ignored by Git.

The shipped JavaScript and CSS total **4,438 bytes gzip**. The browser tests passed in Chromium, Firefox, and WebKit, and the mixed raw/JSON benchmark received 600,000 messages over 10 minutes. See [VALIDATION.md](VALIDATION.md) for the measured results and their scope.

**Run the example**

```sh
python3.9 -m venv .venv39
.venv39/bin/python -m pip install -r requirements-build.txt
.venv39/bin/python tools/build.py
.venv39/bin/python examples/server.py
```

Open `http://127.0.0.1:8000`. The server uses only Python's standard library and serves the generated distribution files. Build once after cloning and again after changing the library sources. To simulate a broken connection or a silent device:

```sh
python3.9 examples/server.py --disconnect-every 10
python3.9 examples/server.py --stall-after 5
```

The demo's silence timeout is 30 seconds. Its server sends a fresh snapshot on each connection; it does not replay missed history. Press Ctrl+C to stop it. `--host`, `--port`, and `--rate` configure the listener and sample frequency; the default listener is localhost only.

**Use in a page**

```html
<head>
  <link rel="stylesheet" href="/turbo-sse.css">
  <script defer src="/debug-transforms.js"></script>
  <script defer src="/turbo-sse.min.js"></script>
</head>
<body data-sse-connect="/events"
      data-sse-events="diagnostic"
      data-sse-timeout="30000">
  <p>Temperature:
    <span data-sse-event="temperature"
          data-sse-transform="celsius_to_degree">—</span>
  </p>

  <p>RPM:
    <span data-sse-event="telemetry" data-sse-json="/rpm">—</span>
  </p>

  <pre data-sse-event="log"
       data-sse-swap="append"
       data-sse-limit="500"></pre>
</body>
```

`debug-transforms.js` belongs to your application:

```javascript
window.celsius_to_degree = function (value) {
  const degrees = Number(value);
  return Number.isFinite(degrees) ? `${degrees.toFixed(1)} °C` : "—";
};
```

Serve an SSE response containing:

```text
retry: 2000

id: boot42:1
event: temperature
data: 23.6

id: boot42:2
event: telemetry
data: {"rpm":1450,"voltage":12.4}

id: boot42:3
event: log
data: Motor started
data:

event: heartbeat
data: alive

```

Each event ends with a blank line. The empty second `data:` line in the log event preserves a trailing newline in its payload. The temperature displays `23.6 °C`, the RPM displays `1450`, and the log appends `Motor started\n`.

Serve UTF-8 with `Content-Type: text/event-stream` and `Cache-Control: no-cache`. Flush complete events and disable any proxy buffering. The demo's `encode_event()` function handles strings, multiline data, Unicode, and empty IDs; explicitly use `json.dumps()` for JSON events. Keep firmware messages small (16 KiB or less is recommended).

**Attributes**

| Attribute | Behavior | Default |
| --- | --- | --- |
| `data-sse-connect` | SSE URL on a single connection root | Required |
| `data-sse-events` | Additional event names to capture, separated by whitespace | None |
| `data-sse-timeout` | Silence timeout in milliseconds | `0`, disabled |
| `data-sse-buffer-events` | Maximum retained CSV records | `10000` |
| `data-sse-buffer-bytes` | Capture string-storage budget | `2097152` |
| `data-sse-event` | Event name for a bound element; `message` for unnamed events | Required |
| `data-sse-json` | JSON Pointer selecting a value; `""` selects the whole document | Absent: raw string |
| `data-sse-transform` | Name of your global transform function | None |
| `data-sse-swap` | `replace` contents or `append` entries | `replace` |
| `data-sse-format` | `text` or trusted `html` | `text` |
| `data-sse-limit` | Maximum retained entries in an append target | `500` |

Only one connection root is supported per page. Bindings must be descendants of the root and must not contain other bindings. Numeric limits must be positive safe integers; the timeout also accepts zero. Root connection/capture options are read at initialization; changing them requires `destroy()` and `init()`.

Events mentioned in bindings are subscribed automatically. Declare every other event name in `data-sse-events` if it must appear in CSV. Native `EventSource` has no wildcard subscription, so unknown names cannot be observed or counted. `message` and `heartbeat` are always captured. Reserve `open` and `error` for the connection lifecycle.

Text bindings render strings literally, including leading zeros, JSON-looking text, and HTML characters. Replacement preserves the bound element. Append inserts one entry per event without adding separators or reparsing previous entries. Append targets are owned by the library and start empty on initialization; a refresh that changes their binding configuration resets their history.

HTML insertion must be explicitly enabled with `data-sse-format="html"` and is intended for trusted device-generated markup. It does not sanitize content. A fragment with several nodes still counts as one append entry. The library does not scan inserted HTML for new bindings automatically.

**JSON and transforms**

JSON parsing happens only when a binding uses `data-sse-json`, at most once per message. JSON Pointer supports nested objects and arrays, such as `/sensors/0/value`; use `~1` for `/` and `~0` for `~` in keys. Missing paths leave that binding unchanged. Malformed JSON skips JSON bindings and increments the JSON-error count while raw bindings and CSV capture continue.

The pipeline is **raw string or selected JSON value → optional transform → text conversion → DOM update**. For example:

```html
<span data-sse-event="telemetry"
      data-sse-json="/temperature"
      data-sse-transform="celsius_to_degree">—</span>
```

With `{"temperature":23.6}`, your function receives the number `23.6`. Without `data-sse-json`, it receives the original string. The same transform works with `data-sse-swap="append"`.

- Define your function as a property of `window` before the library initializes. Module scripts can assign to `window` and then call `TurboSSE.refresh()` after registration.
- Function names are resolved and cached at initialization/refresh. Attributes accept simple names such as `celsius_to_degree`, with no expressions, function calls, or dotted paths.
- Functions are synchronous and run once per matching binding per received message, before rendering is batched. Keep them fast. Treat shared JSON inputs as read-only and return a derived value.
- Strings are rendered as returned; numbers and booleans become text; objects/arrays become compact JSON; `null` becomes an empty string. Returning `undefined` skips the update.
- Missing functions disable their bindings until a successful refresh. Exceptions, asynchronous results, and unsupported return types skip only the affected update. Counters in the topbar expose errors.
- Transform output uses literal text unless HTML mode is explicitly enabled. CSV always retains the original payload, including when a transform fails.

**Connection status and history**

The topbar displays text and color: Connecting/Reconnecting in amber, Connected in green, and Stalled/Disconnected in red. Its status region announces state changes, while counters update at most once per second. Export CSV and Retry are keyboard-accessible buttons.

Normal transient failures use the existing native `EventSource` reconnect behavior and the server's `retry:` interval. Terminal closure, including HTTP 204, shows Disconnected and a manual Retry button; the browser does not expose the specific HTTP status to the library.

When `data-sse-timeout` is enabled, send a named application heartbeat at least three times as often as the timeout (e.g. every 10 seconds for a 30-second timeout). Any captured message resets liveness. SSE comments do not count. An open stream that remains silent is closed and recreated after two seconds. The watchdog is inactive during the browser's native reconnect attempts.

Native reconnect sends `Last-Event-ID`. Watchdog/manual replacement passes the last received ID in a URL-encoded `lastEventId` query parameter. Firmware should prefer the header when present, then the query parameter. Use IDs containing a boot/session prefix. Replay from a small device-side buffer if available; otherwise send a fresh snapshot. TurboSSE does not deduplicate events or recover history the device cannot replay.

**CSV and memory bounds**

CSV contains `received_at,elapsed_ms,event,last_event_id,data`. The timestamp is browser wall-clock time and elapsed time is monotonic since initialization. `last_event_id` is the browser's resume cursor and may be inherited from a previous event. Payloads are the original `MessageEvent.data` strings, with only CSV escaping applied. SSE comments and wire framing are outside the capture scope. Export downloads a snapshot and keeps reception running.

Capture uses a ring buffer limited by event count and string storage. The byte budget charges two bytes per UTF-16 code unit for payloads, names, and IDs; it is not an exact JavaScript heap measurement. Old records are evicted whole. Records larger than the entire budget are dropped whole, counted as Oversized, and still eligible for rendering.

Each append binding also has a fixed 256 KiB string budget, applied to transformed output. Pending and displayed entries share the same limits. Old entries are discarded and reported as Append drops; a single oversized entry is skipped. Replacement targets keep only the newest pending value per animation frame. This bounds queues when rendering is suspended, while CSV capture retains intermediate messages within its own limits. Memory used inside user transforms is under application control.

**JavaScript API**

```javascript
TurboSSE.init();       // Automatic on page load; repeated calls are harmless.
TurboSSE.refresh();    // Rescan bindings and re-resolve transforms after markup changes.
TurboSSE.exportCSV();  // Download a CSV snapshot; also returns its string contents.
TurboSSE.stats();      // Read counters, state, retained bytes, and lastEventId.
TurboSSE.destroy();    // Close the stream, cancel work, release capture, remove the bar.
```

`init(rootElement)` can select the root explicitly. `refresh()` preserves unchanged append bindings and previously registered event subscriptions. `stats()` returns a copy with `received`, `retained`, `bytes`, `evicted`, `oversized`, `parseErrors`, `transformErrors`, `configErrors`, `appendDrops`, `state`, and `lastEventId`. Counters are cumulative since initialization. After destruction, `stats()` returns `null`; a later `init()` starts a fresh session. Destruction leaves already-rendered application values in the page.

**Build and test with Python 3.9**

```sh
python3.9 -m venv .venv39
.venv39/bin/python -m pip install -r requirements-dev.txt
PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright" .venv39/bin/python -m playwright install chromium firefox webkit
.venv39/bin/python tools/build.py
.venv39/bin/python -m unittest discover -s tests -v
.venv39/bin/python tools/build.py --check
```

The tests run against real localhost SSE endpoints in Chromium, Firefox, and WebKit. They verify raw/JSON rendering, transforms and error isolation, append/capture limits, actual CSV downloads, reconnect cursors, watchdogs, terminal closure, and lifecycle cleanup. Run a single browser while developing:

```sh
.venv39/bin/python -m unittest tests.test_browser.ChromiumTests -v
```

`TURBO_SSE_BROWSERS=chromium,firefox` selects engines for discovery. `TURBO_SSE_ASSET=src/turbo-sse.js` exercises the readable source instead of the default minified asset. The Python tests and example require no Node.js installation. Playwright and rjsmin are development dependencies only.

The build emits minified assets, deterministic `.gz` variants, and C headers for both JavaScript representations, and enforces a combined 5 KiB gzip budget for the JavaScript and CSS. When serving a precompressed `.gz` asset, keep the original JavaScript/CSS content type and send `Content-Encoding: gzip`; do not merely link to a `.gz` URL without that header.

**Embed the JavaScript in firmware**

Include `dist/turbo-sse.h` in the C or C++ source file that serves the library. It defines two symbols with internal linkage:

| Symbol | Type | Meaning |
| --- | --- | --- |
| `turbo_sse_js` | `const unsigned char[]` | The minified JavaScript bytes |
| `turbo_sse_js_len` | `const size_t` | Number of bytes to send |

Send `turbo_sse_js_len` bytes from `turbo_sse_js` with `Content-Type: text/javascript; charset=utf-8`. The array contains the exact UTF-8 bytes of `turbo-sse.min.js`, uncompressed and without a trailing NUL. Use the length rather than `strlen`, and do not send `Content-Encoding: gzip` for these bytes. Include the header in the serving translation unit to avoid keeping extra copies in firmware; adapt storage placement to your platform if needed.

For a smaller firmware payload, include `dist/turbo-sse-gzip.h`. It embeds the exact bytes of `turbo-sse.min.js.gz` and defines:

| Symbol | Type | Meaning |
| --- | --- | --- |
| `turbo_sse_js_gz` | `const unsigned char[]` | Gzip-compressed minified JavaScript |
| `turbo_sse_js_gz_len` | `const size_t` | Compressed byte length to send |

Serve `turbo_sse_js_gz_len` bytes from `turbo_sse_js_gz` directly, with `Content-Type: text/javascript; charset=utf-8` and `Content-Encoding: gzip`. If sending `Content-Length`, use the compressed length. The browser decompresses the response; the device does not need to compress or decompress anything at runtime. Use the supplied length because gzip data contains embedded NUL bytes. The two headers have distinct symbols and include guards and can coexist when both representations are needed.

The Python build creates both headers automatically, and `tools/build.py --check` checks them for staleness alongside the browser assets. Header tests compile C99 and C++11 programs that include both headers and write the embedded bytes, then compare their output against the corresponding files. Gzip output is also decompressed and compared with the original minified JavaScript. These tests require `cc` and `c++`, which are available on the GitHub-hosted Ubuntu runner.

**GitHub Actions build**

The `Build minified library` workflow runs on pushes, pull requests, published GitHub Releases, and manual dispatch. It uses Python 3.9, installs `requirements-build.txt`, builds the assets, checks the size budget and distribution, and uploads a `turbo-sse-dist` artifact containing:

- `turbo-sse.min.js`
- `turbo-sse.css`
- Their precompressed `.gz` variants
- `turbo-sse.h`, exposing the minified JavaScript for C/C++ firmware
- `turbo-sse-gzip.h`, exposing the gzip-compressed minified JavaScript

Download the artifact from the workflow run's **Artifacts** section. Artifacts are retained for 30 days. The workflow runs the server/distribution and C-header tests; the full browser suite remains available through the test command above. Distribution files are generated during the workflow and are not committed to Git.

When a GitHub Release is published, a second job downloads the verified artifact and attaches all six files to that release's **Assets** section. The build job uses read-only repository permissions; only the release upload job gets `contents: write`. Creating or pushing a tag by itself produces an Actions artifact. Publish a GitHub Release for that tag to get release downloads automatically. The tagged commit must include this updated workflow for the automatic release trigger to run.

To attach files to an existing release whose tag predates the workflow update:

1. Commit and push this workflow to the default branch.
2. Open **Actions → Build minified library → Run workflow** and select the default branch.
3. Set **release_tag** to the existing tag (for example, `0.1.0`) and run it.

The manual run checks out the specified tag, builds and verifies its files, and uploads them to the existing release. The tagged version must include the build script and header tests. Leave **release_tag** empty for a normal build without release uploads. Re-running a release upload replaces assets with matching filenames using `gh release upload --clobber`; it does not move the tag or create another release.

To build locally without installing browser-test dependencies:

```sh
.venv39/bin/python -m pip install -r requirements-build.txt
.venv39/bin/python tools/build.py
```

Run the reproducible benchmark:

```sh
.venv39/bin/python tools/benchmark.py --seconds 600 --rate 1000 --bindings 100 \
  --mode mixed --transform --output benchmarks/local.json
```

Use `--mode raw`, `mixed`, or `json`, and omit `--transform` to measure untransformed values. The benchmark includes a brief suspension of render callbacks to exercise pending queues. It records receive/transform and render callback timings, post-GC heap samples, capture evictions, and append drops. Render timings exclude browser layout/paint, and instrumented throughput is specific to the reported browser and hardware. See `benchmarks/` for measured results.
