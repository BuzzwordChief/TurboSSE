**TurboSSE**

A standalone JavaScript library for embedded-device debug pages. Bind SSE events to values, logs, and scientific time-series plots. Inspect synchronized plots, retain bounded statistical history, and download original events plus a separate CSV for each series. The sticky toolbar shows connection status and estimated device uptime. Everything runs on ordinary HTTP pages with no runtime dependencies.

Build the runtime into `dist/turbo-sse.min.js` and `dist/turbo-sse.css`, or download the GitHub Actions artifact. Copy both files onto your device. No Node.js, bundler, CDN, or Python is needed on the device. Readable sources are in `src/`; Python 3.9 is used for the example server, build tooling, and tests. Generated `dist/` files are ignored by Git.

The shipped JavaScript and CSS total **17,649 bytes gzip** (17.2 KiB). This exceeds the soft 8 KiB target; the complete graphing/inspection/export implementation, including the classless page styles, has an 18 KiB regression ceiling. Chromium, Firefox, and WebKit tests cover the runtime and downloads. See [VALIDATION.md](VALIDATION.md) for numerical simulations, live-run results, tested hashes, and their scope.

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
python3.9 examples/server.py --restart-every 20
python3.9 examples/server.py --rate 100
```

The demo is a two-column page styled only by `turbo-sse.css`: overlaid inlet/outlet temperatures above a table of real-time values, and synchronized motor-speed/voltage panels beside them. Its 1 MiB graph budget makes compaction easy to exercise at higher sample rates. Uptime belongs to the simulated device, not the connection; `--disconnect-every` preserves it, while `--restart-every` resets it. The silence timeout is 30 seconds. The server sends a fresh snapshot on each connection; it does not replay missed history. Press Ctrl+C to stop it. `--host`, `--port`, and `--rate` configure the listener and sample frequency; the default listener is localhost only.

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

**Graph values with HTML**

Add `data-sse-graph` to a numeric binding. The existing event/JSON selection syntax works unchanged:

```html
<div data-sse-event="temperature"
     data-sse-graph data-sse-label="Temperature" data-sse-unit="°C"></div>
```

A container without its own event binding can overlay several series. Matching sync names link the time window, cursor and A/B selection across panels:

```html
<div data-sse-graph data-sse-title="Thermal response" data-sse-sync="motor" data-sse-window="60">
  <span data-sse-event="telemetry" data-sse-json="/inlet"
        data-sse-label="Inlet" data-sse-unit="°C"></span>
  <span data-sse-event="telemetry" data-sse-json="/outlet"
        data-sse-label="Outlet" data-sse-unit="°C"></span>
</div>
<div data-sse-event="telemetry" data-sse-json="/rpm"
     data-sse-graph data-sse-sync="motor"
     data-sse-label="Motor speed" data-sse-unit="rpm"></div>
```

Keep one unit per panel; use stacked panels for different quantities. The first panel in a sync group sets its Live window. Graphs fill their container; the plot area is 220 px tall; set `--turbo-sse-height` in CSS to change it. `data-sse-y-min` and `data-sse-y-max` optionally fix the y range. Each graph generates a header showing its title and the units of its series. The title is `data-sse-title`, else the graph's own `data-sse-label`, else the series labels. Graphs own generated header/controls/canvas/legend DOM and temporarily hide their source spans; destruction restores those spans. The source elements themselves remain intact.

Hovering shows a crosshair; the readout row lists the elapsed time, the y value under the pointer, and the nearest sample. Legend entries toggle a series (Shift-click isolates one); a hidden series keeps an outlined swatch so it is still listed.

- A plot is inactive until you click it or move keyboard focus into it. Hovering an inactive plot shows "Click to interact", and the wheel scrolls the page as usual. The first click only activates the plot; clicking elsewhere or tabbing away deactivates it. Clicking a toolbar control keeps the plot active and returns keyboard focus to the plot, so its shortcuts keep working; a control activated from the keyboard keeps focus. On touch screens an inactive plot lets the page scroll, and the first tap activates it.
- Drag to pan and use the wheel to zoom around the pointer. While **Live** is checked, the wheel only changes the followed window, so zooming in or out keeps tracking incoming data; panning or selecting a range unchecks Live. Checking Live again keeps the current span and moves it to the newest data. **Fit** is a one-time action: it shows all retained history and restores automatic y scaling. It leaves Live as it is; while Live is checked, the followed window then covers all history as data arrives. Right-drag selects a time range to zoom into, shown as a gray band with dashed edges; Shift with right-drag also zooms y.
- Shift-drag measures an interval, shown as an amber band between solid A and B lines. Measuring and placing a marker both uncheck Live so the markers stay in view. The markers are labelled A and B on the outer side of the measured interval, and the first measurement row lists each marker's own time. On touch screens, drag pans and two taps set A/B. Keyboard `A` and `B` set them at the cursor, or the view center; Escape clears/cancels. Readouts include delta time/value, slope, count, extrema, peak-to-peak, mean, RMS and population standard deviation.
- Left/right arrows pan, `+`/`-` zoom, `L` toggles Live, and `F` fits retained history. Shortcuts work while the plot is active, wherever focus is inside it; key combinations with Ctrl, Cmd or Alt are left to the browser. While the plot is active, the Live checkbox and the Fit, Back and Export view buttons appear in its header, and a key legend for the pointer and keyboard controls appears in a band above the data; Live and Fit show their `L` and `F` keys. The band is reserved, so the legend never covers data. Touch screens show no key legend.
- Click a legend entry, or press Enter or Space on it, to hide/show it; Shift-click isolates it. Legend, readout and measurement text can be selected and copied; selecting legend text does not toggle the series. Acquisition continues for hidden series. **Back** restores an earlier time window.
- **Export view** downloads a ZIP with the selected plot's series for the visible or A/B interval. The topbar's **Export All** downloads a ZIP with all retained data.

Raw numeric strings and selected JSON numbers are accepted. Null/missing/invalid data creates a visible gap; invalid numbers increment Graph errors. Returning `undefined` from a graph transform skips that update. Graph transforms must return a numeric value (or null/undefined), be synchronous, and be pure. Identical event/selector/transform/unit sources share history and evaluate their transform once per event, even across several plots. Ordinary text transforms retain their per-binding behavior. Use a numeric unit conversion for a graph; a display transform returning `"23.6 °C"` is not a graph value.

**Attributes**

| Attribute | Behavior | Default |
| --- | --- | --- |
| `data-sse-connect` | SSE URL on a single connection root | Required |
| `data-sse-events` | Additional event names to capture, separated by whitespace | None |
| `data-sse-timeout` | Silence timeout in milliseconds | `0`, disabled |
| `data-sse-buffer-events` | Maximum retained CSV records | `10000` |
| `data-sse-buffer-bytes` | Capture string-storage budget | `2097152` |
| `data-sse-omit-raw` | Root list of event names to omit only from raw capture | Empty: omit nothing |
| `data-sse-uptime-event` | Root event name carrying a plain uptime float in seconds | `uptime` |
| `data-sse-graph-bytes` | Root accounted graph-history/index budget; minimum 8192 | `33554432` (32 MiB) |
| `data-sse-graph` | Enable a numeric plot or group child series | Absent |
| `data-sse-sync` | Shared time-navigation/cursor group | Independent |
| `data-sse-title` | Graph header title | The graph's `data-sse-label`, else its series labels |
| `data-sse-label`, `data-sse-unit` | Series name and unit | Event name; no unit |
| `data-sse-window` | Initial/Live visible seconds; positive finite number | `60` |
| `data-sse-y-min`, `data-sse-y-max` | Optional finite y bounds, min below max | Automatic |
| `data-sse-event` | Event name for a bound element; `message` for unnamed events | Required |
| `data-sse-json` | JSON Pointer selecting a value; `""` selects the whole document | Absent: raw string |
| `data-sse-transform` | Name of your global transform function | None |
| `data-sse-swap` | `replace` contents or `append` entries | `replace` |
| `data-sse-format` | `text` or trusted `html` | `text` |
| `data-sse-limit` | Maximum retained entries in an append target | `500` |

Only one connection root is supported per page. Bindings must be descendants of the root and must not contain other bindings. Numeric limits must be positive safe integers; the timeout also accepts zero. Root connection/capture/history/uptime options are read at initialization; changing them requires `destroy()` and `init()`.

Events mentioned in bindings are subscribed automatically. Declare every other event name in `data-sse-events` if it must appear in CSV. Native `EventSource` has no wildcard subscription, so unknown names cannot be observed or counted. `message`, `heartbeat`, and the configured uptime event are always subscribed. Their raw capture can be explicitly omitted. Reserve `open` and `error` for the connection lifecycle.

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
- Transform output uses literal text unless HTML mode is explicitly enabled. Raw CSV retains the original payload, including when a transform fails, unless that event was explicitly omitted or evicted.

**Uptime and estimated restarts**

```html
<body data-sse-connect="/events" data-sse-uptime-event="uptime">
```

```text
event: uptime
data: 1234.567

```

The data is a finite, nonnegative decimal float in seconds. No JSON clock payload, boot ID or per-measurement device timestamp is needed. One report establishes an estimate; periodic reports correct it. Send at least one on each connection if reconnect synchronization matters. Empty, malformed, negative or nonfinite reports leave the previous anchor intact and increment Clock errors.

The toolbar displays `Uptime ≈HH:MM:SS` using the report plus elapsed browser monotonic time, updated once a second. It displays unknown/unsynchronized time before the first report and after a disconnect until a fresh report arrives. Samples keep their timing estimate from reception; later reports do not silently retimestamp historical values.

After reconnect, only the first valid report is compared with the last **reported** uptime. A lower value adds an estimated restart marker and starts a local segment; previous graph history stays available. Equal/higher values and ordinary periodic updates do not add markers. Marker time is estimated from report arrival minus reported uptime. Network buffering, clock drift and browser suspension affect this estimate; restarts can be missed when the new uptime already exceeds the last value seen. The local segment is bookkeeping, not a device identifier.

**Connection status and history**

The topbar displays text and a colored marker: Connecting/Reconnecting in amber, Connected in green, and Stalled/Disconnected in red. Its status region announces state changes, while counters update at most once per second. Export All and Retry are keyboard-accessible buttons. Export progress and export errors appear next to Export All in a second status region.

**Styling**

`turbo-sse.css` follows the look of the HAProxy status page: 12 px Arial, black on white, 1 px gray rules, navy header bars, beige bands, tinted connection states (green, amber, red), and a yellow key legend. Numbers use tabular figures.

It is also a small classless stylesheet for the page around the plots, so a device page needs no classes and no stylesheet of its own; the example uses none. It styles plain elements:

- `body` and `main` set the font, colors and a centered page up to 1400 px wide.
- Each `<section>` directly inside `<main>` becomes a column; columns sit side by side when there is room for at least 480 px each and stack otherwise. Everything else in `<main>` spans the full width.
- A `<header>` directly inside `<main>` lays out the `<h1>` title and a `<p>` tagline on one ruled line. `<h2>` is the navy italic subtitle style.
- `<h3>` and table `<caption>` are navy bands, like the plot headers, so a captioned table reads as a panel.
- Tables collapse their borders, `thead` cells get the beige band, and cells use tabular figures.
- `<details>` is set off by a rule with a bold `<summary>`; `<section>` blocks inside it get a gray border. `<pre>` wraps long lines and scrolls beyond 240 px.
- `<footer>`, links, `<kbd>`, buttons, disabled buttons and keyboard focus rings get matching styles; `[hidden]` always hides.

These are element selectors, so any application rule for the same element overrides them. The canvas takes its axis, tick, and grid color from the computed `color` of `.turbo-sse-area`, so restyling the plot does not require editing the script. Series colors come from a fixed six-color palette in the script and are exposed to the legend as `--series-color`.

Normal transient failures use the existing native `EventSource` reconnect behavior and the server's `retry:` interval. Terminal closure, including HTTP 204, shows Disconnected and a manual Retry button; the browser does not expose the specific HTTP status to the library.

When `data-sse-timeout` is enabled, send a named application heartbeat at least three times as often as the timeout (e.g. every 10 seconds for a 30-second timeout). Any captured message resets liveness. SSE comments do not count. An open stream that remains silent is closed and recreated after two seconds. The watchdog is inactive during the browser's native reconnect attempts.

Native reconnect sends `Last-Event-ID`. Watchdog/manual replacement passes the last received ID in a URL-encoded `lastEventId` query parameter. Firmware should prefer the header when present, then the query parameter. Use IDs containing a boot/session prefix. Replay from a small device-side buffer if available; otherwise send a fresh snapshot. TurboSSE does not deduplicate events or recover history the device cannot replay.

**CSV exports and raw omission**

Every export button uses the same path: it freezes one snapshot and downloads it directly as one ZIP named `sse-<timestamp>.zip`, even when it holds a single CSV. **Export All** includes `raw-events.csv` and one CSV per unique series; pages without graphs get just the raw file. **Export view** includes the series of one plot for its visible or A/B interval. Multiple plot views of the same source produce one series file. Every ZIP starts with `export.txt`, which records when the snapshot was taken, whether it covers all retained data or a plot interval, and each file with its coverage and size. The ZIP is stored without compression, so it is built from the prepared files without copying them and needs no extra library; compress it afterwards if size matters. There is no browser disk-streaming API.

**Raw events are captured by default even when graphed.** To save raw-buffer space explicitly:

```html
<body data-sse-connect="/events"
      data-sse-omit-raw="temperature telemetry">
```

The list is whitespace-separated and matches whole event names. Empty/absent means omit nothing. It does not subscribe to new names or suppress graphs, text/log bindings, uptime, liveness or resume cursors. Omission removes the entire original payload, including unplotted JSON fields, and still applies if parsing/transformation fails. Intentional omissions have their own counter. Configure it before initialization.

The raw file and `TurboSSE.exportCSV()` retain the existing five-column schema. Series files instead contain the stored numeric values actually plotted, after numeric transforms and before display rounding. They export retained samples/summaries, never the reduced set of drawing points. Each file is self-contained:

| Fields | Meaning |
| --- | --- |
| `series,event,json_pointer,transform,unit` | Series/source metadata; blank selector can mean a raw source or whole-document JSON selection. |
| `kind` | `sample`, `summary`, `gap`, or estimated `restart`. |
| `elapsed_start_s,elapsed_end_s` | Point or covered interval in browser elapsed seconds. |
| `uptime_start_s,uptime_end_s,segment` | Estimated device time and local segment; unknown uptime is empty. |
| `value,count` | Exact retained sample value and count; summary `value` is empty. |
| `min,max,mean,stddev,first,last,min_elapsed_s,max_elapsed_s` | Summary statistics and extrema times; `stddev` is population deviation. These columns are empty for ordinary samples. |
| `gaps` | Number of represented gaps/invalid samples. |
| `detected_elapsed_s` | When a restart was inferred, separate from its estimated position. |

A summary describes multiple samples over an interval. Its mean is never exported as a pretend original point. Requested intervals intersecting a summary include that entire bucket and report the effective coverage. Gap and restart rows carry no measurement value. Original payloads, unselected JSON fields and compacted individual samples cannot be reconstructed from these numeric CSVs; retain raw capture or use an external raw-stream recorder when those are needed.

Export preparation freezes a bounded copy, yields between batches and leaves acquisition running. Only one export is prepared at a time. Its temporary budget is computed from configured capture/history budgets, between 8 and 256 MiB; it includes snapshot accounting, encoded output and a transient Blob-copy allowance. A too-large export fails with a message next to Export All before anything is downloaded: use Export view for a smaller range. Prepared data is released 60 seconds after the download starts, when another export starts, or when the runtime is destroyed. Browser-native allocation/GC timing is not an exact process-memory guarantee.

**CSV and memory bounds**

CSV contains `received_at,elapsed_ms,event,last_event_id,data`. The timestamp is browser wall-clock time and elapsed time is monotonic since initialization. `last_event_id` is the browser's resume cursor and may be inherited from a previous event. Payloads are the original `MessageEvent.data` strings, with only CSV escaping applied. SSE comments and wire framing are outside the capture scope. Export downloads a snapshot and keeps reception running.

Capture uses a ring buffer limited by event count and string storage. The byte budget charges two bytes per UTF-16 code unit for payloads, names, and IDs; it is not an exact JavaScript heap measurement. Old records are evicted whole. Records larger than the entire budget are dropped whole, counted as Oversized, and still eligible for rendering.

Each append binding also has a fixed 256 KiB string budget, applied to transformed output. Pending and displayed entries share the same limits. Old entries are discarded and reported as Append drops; a single oversized entry is skipped. Replacement targets keep only the newest pending value per animation frame. This bounds queues when rendering is suspended, while CSV capture retains intermediate messages within its own limits. Memory used inside user transforms is under application control.

Graph history uses indexed Float64 chunks and statistical summaries. It stays exact while the shared history budget permits; a busy series can use idle series' space. Under pressure, oldest raw blocks lose individual samples while retaining count, extrema and their times, first/last values, mean, population deviation and gaps. Older summaries merge progressively. Means are count-weighted; deviation is merged without squaring large/tiny values. There is no fixed age at which raw detail expires, and changing the visible window does not change retention.

`data-sse-graph-bytes` covers typed storage plus explicit node/bookkeeping allowances. A small part is reserved for restart markers, and each distinct source needs at least 4 KiB of usable capacity. Canvas/browser-native memory is additional. Inspection displays coarse intervals as envelopes and labels summarized history. Different inferred restart segments are not merged into one ordinary summary. If too many incompatible segments exhaust even summary capacity, oldest coverage expires and is counted. Marker retention is bounded separately and reports `markerEvictions`.

Per-series `samples` counts retained valid measurements including those represented by summaries; `raw` counts exact retained records including gaps, `compacted` counts records converted to summaries, and `evicted` counts expired records. Accounted bytes are a limit on managed storage, not an exact JavaScript heap measurement.

**JavaScript API**

```javascript
TurboSSE.init();       // Automatic on page load; repeated calls are harmless.
TurboSSE.refresh();    // Rescan bindings and re-resolve transforms after markup changes.
TurboSSE.exportCSV();  // Download a CSV snapshot; also returns its string contents.
TurboSSE.stats();      // Read counters, state, retained bytes, and lastEventId.
TurboSSE.destroy();    // Close the stream, cancel work, release capture, remove the bar.
```

`init(rootElement)` can select the root explicitly. `refresh()` preserves unchanged append bindings, shared graph histories, inspection state, and previously registered event subscriptions. Label changes preserve graph data; changing a graph source or resolved transform resets that source. Removing one view does not erase a source still used by another. Destruction removes generated graph/export UI and releases its data and observers. `stats()` returns a copy with `received`, `retained`, `bytes`, `evicted`, `oversized`, `parseErrors`, `transformErrors`, `configErrors`, `appendDrops`, `state`, and `lastEventId`. It also includes `omitted`, `clockErrors`, `restarts`, `graphErrors`, `markerEvictions`, current estimated `uptime` (or null), `lastUptime`, `segment`, and `graphs`. `graphs` contains accounted `bytes`, plot count, and a series list with `id,label,event,raw,compacted,evicted,bytes,samples,gaps,from,to`; coverage is in browser elapsed seconds. Counters are cumulative since initialization. After destruction, `stats()` returns `null`; a later `init()` starts a fresh session. Destruction leaves already-rendered application values in the page.

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

The build emits minified assets, deterministic `.gz` variants, and C headers for both JavaScript representations, and reports the soft 8 KiB combined gzip target and enforces an 18 KiB regression ceiling for JavaScript and CSS. When serving a precompressed `.gz` asset, keep the original JavaScript/CSS content type and send `Content-Encoding: gzip`; do not merely link to a `.gz` URL without that header.

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

**Graph verification and benchmarks**

```sh
.venv39/bin/python -m unittest tests.test_history tests.test_graphs -v
# Eight hours of generated measurements, processed as an accelerated simulation:
.venv39/bin/python tools/benchmark_graphs.py --mode history --seconds 28800 \
  --rate 100 --channels 8 --output benchmarks/local-history.json
# Actual wall-clock streaming; 30 minutes is the default live-test duration:
.venv39/bin/python tools/benchmark_graphs.py --mode soak --seconds 1800 \
  --rate 100 --channels 8 --budget 8388608 --export-every 300 \
  --output benchmarks/local-soak.json
```

History mode exercises the production indexed store against independent numerical reference calculations. It does not wait for the simulated hours to elapse. Soak mode serves actual SSE to four Canvas panels and periodically builds CSV snapshots. Reports record the tested asset hash, browser, accounting/heap samples and callback timings. Callback duration excludes browser paint. See VALIDATION.md for which runs completed and which are observation-only.
