**TurboSSE — proposed library and example usage**

Implemented in `src/` and `dist/`. See [README.md](README.md) for the shipped API, Python 3.9 examples, and test commands. This document records the design used for implementation.

Build a dependency-free JavaScript library for an embedded device's debugging page. HTML attributes bind incoming values to elements; the library adds a connection-status bar, reconnects, and exports received messages as CSV. Payloads are primarily raw strings, with explicit JSON extraction and user-defined transforms when needed. This document is the implementation plan; the examples describe the proposed API.

**1. Keep the first version small**

- Ship one browser script and a small stylesheet, served directly by the device. No application build step, CDN, framework, or runtime dependency.
- Target **at most 5 KiB gzip for JavaScript and CSS combined**, including the toolbar and CSV export. This is a budget to verify during implementation, not a measured result. Report uncompressed and minified sizes too, since firmware may serve uncompressed assets.
- Support one stream per page initially, with any number of bindings inside its root. Start automatically when the deferred script runs; initialization must be idempotent.
- Use native `EventSource`. It provides SSE parsing and normal reconnection, including the server's `retry:` interval and `Last-Event-ID` handling. [WHATWG SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- Keep the declarative binding style familiar to HTMX users. The proposed attributes are this library's API; HTMX itself is not required. [HTMX SSE extension](https://htmx.org/extensions/sse/)

**2. Define a compact message contract**

Use the SSE event name to route a message, and treat its `data` as a raw string by default. Firmware does not need to construct a JSON envelope for individual values or log messages. Some named events may carry JSON when grouping several values is useful.

```text
retry: 2000

id: boot42:101
event: temperature
data: 23.6

id: boot42:102
event: log
data: Motor started
data:

id: boot42:103
event: telemetry
data: {"rpm":1450,"voltage":12.4}

id: boot42:104
event: status
data: <strong>Running</strong>

event: heartbeat
data: alive

```

Every event must end with a blank line. Serve UTF-8 with `Content-Type: text/event-stream` and `Cache-Control: no-cache`; flush complete events and disable intermediary buffering where applicable. Firmware should limit each message to 16 KiB as an initial contract.

The log example's empty second `data:` line gives the delivered string a trailing newline. Without JSON extraction or a transform, append preserves payload characters exactly and does not invent separators. An event without an `event:` field is routed as `message`.

Register one listener per distinct event name found in bindings or the root's `data-sse-events` list, plus `message` and `heartbeat`. Register listeners before the connection can dispatch messages. Reserve `open` and `error` for transport lifecycle events in the initial firmware contract.

**Complete capture requires declaring every event type the firmware emits.** Types without a visible binding must appear in `data-sse-events`. Native `EventSource` cannot listen to an unknown name through a wildcard; such messages cannot be captured or counted by this library. Keep that list in sync with firmware. [HTMX's explanation of named and unnamed events](https://htmx.org/extensions/sse/#receiving-unnamed-events)

JSON is opt-in per binding, never guessed from the first character of a payload. A raw binding without a transform displays `0012`, `true`, or `{"rpm":1450}` literally. A binding with `data-sse-json="/rpm"` parses the payload and selects that value. Multiple bindings can read the same event, mixing raw display and JSON extraction.

**3. Bind values through HTML attributes**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Device debug</title>
    <link rel="stylesheet" href="/turbo-sse.css">
    <script defer src="/debug-transforms.js"></script>
    <script defer src="/turbo-sse.min.js"></script>
  </head>
  <body data-sse-connect="/events"
        data-sse-events="diagnostic trace"
        data-sse-timeout="30000">
    <!-- The library inserts the status/export bar here. -->

    <!-- Transform the raw string, then replace the contents. -->
    <p>Temperature: <span data-sse-event="temperature"
                          data-sse-transform="celsius_to_degree">—</span></p>

    <!-- Raw strings, appended in received order. -->
    <pre data-sse-event="log"
         data-sse-swap="append"
         data-sse-limit="500"></pre>

    <!-- Opt-in JSON extraction; telemetry is parsed once per message. -->
    <p>Speed: <span data-sse-event="telemetry" data-sse-json="/rpm">—</span> RPM</p>
    <p>Voltage: <span data-sse-event="telemetry" data-sse-json="/voltage">—</span> V</p>

    <!-- The same event can also be shown as its original text. -->
    <pre data-sse-event="telemetry"></pre>

    <!-- Explicit markup insertion for trusted device-generated HTML. -->
    <div data-sse-event="status" data-sse-format="html"></div>
  </body>
</html>
```

The application's `/debug-transforms.js` defines the function; the library does not provide it:

```javascript
window.celsius_to_degree = function (value) {
  const degrees = Number(value);
  return Number.isFinite(degrees) ? `${degrees.toFixed(1)} °C` : "—";
};
```

The temperature event passes the raw string `"23.6"` to this function and replaces its span's text with `23.6 °C`. The log event appends an entry, including its newline. The telemetry event updates both extracted values and the raw JSON display. The status event replaces its element's contents with the supplied markup. Diagnostic and trace events are captured for CSV even without visible bindings.

| Attribute | Meaning | Default |
| --- | --- | --- |
| `data-sse-connect` | Stream URL on the page's single connection root | Required |
| `data-sse-event` | SSE event name bound to this element; use `message` for unnamed events | Required for bindings |
| `data-sse-events` | Whitespace-separated additional event names to capture without DOM bindings | None |
| `data-sse-json` | JSON Pointer to extract; an empty value selects the complete JSON document | Absent: raw string |
| `data-sse-transform` | Name of a user-defined global function called with the selected value | Absent: no transform |
| `data-sse-swap` | `replace` contents or `append` an entry | `replace` |
| `data-sse-format` | `text` or explicit `html` insertion | `text` |
| `data-sse-limit` | Maximum retained entries for an append target | `500` |
| `data-sse-timeout` | Silence timeout in milliseconds; requires application heartbeats | `0` (disabled) |
| `data-sse-buffer-events` | Maximum captured messages | `10000` |
| `data-sse-buffer-bytes` | Capture string-storage budget | `2097152` |

`replace` preserves the bound element itself. Text uses `textContent` or text nodes; append adds one entry per received value without reparsing existing contents. HTML mode accepts trusted device-generated fragments only; it does not sanitize markup. Track each appended fragment as one entry even when it contains several nodes. Apply a separate 256 KiB string-storage budget per append target, including pending entries, so entry count alone cannot permit unlimited log growth.

JSON selectors use JSON Pointer: `/rpm` selects a property, `/sensors/0/value` traverses an array, and `~1` and `~0` escape `/` and `~` in keys. Resolve only own properties, without evaluating expressions. Precompile selectors during initialization. [JSON Pointer, RFC 6901](https://www.rfc-editor.org/rfc/rfc6901.html)

JSON extraction preserves the selected value's type for the transform. Missing paths leave their binding unchanged and skip the transform, supporting partial telemetry updates. Invalid JSON skips JSON bindings and increments a parse-error counter; raw bindings and capture still receive the original string. Validate selector syntax during initialization. Parse only when at least one binding requests JSON, and at most once per received message.

The rendering pipeline is: select the raw string or JSON value, call the optional transform, normalize the result to text, then queue replacement or append. Capture the original payload before this pipeline. After transformation, strings remain strings, finite numbers and booleans become text, null becomes an empty string, and arrays/objects become compact JSON text. Returning `undefined` skips that binding's update; reject unsupported results rather than inserting accidental function or Promise text.

Transform contract:

- Resolve a simple global name such as `celsius_to_degree` to an own, callable property on `window`, and cache the function during initialization or `TurboSSE.refresh()`. The attribute accepts a name, not JavaScript expressions, calls, or dotted paths; no `eval` or `Function` constructor is needed.
- The application defines the function before initialization. The two deferred scripts above load in dependency order. Module-based applications can explicitly assign their function to `window` before initialization or call `refresh()` after registration.
- Call `transform(value)` synchronously once per matching binding per received message, before DOM batching. Raw bindings receive a string; JSON bindings receive the selected JSON value. Multiple elements may use different transforms on the same event.
- Treat JSON input objects as read-only because parsing is shared across bindings. Return a derived value rather than mutating the input. Transforms should be fast and should not perform DOM work. The library does not clone inputs or await asynchronous results.
- Apply the same contract to both `replace` and `append`. Pending replacement values may still be coalesced after transformation. Charge transformed append strings against the append buffer budget.
- Report a configuration error for a missing/non-callable function and disable that binding until a refresh resolves it. A thrown exception, Promise/thenable result, or unsupported return value skips the affected update and increments a transform-error counter. Other bindings, stream reception, and raw capture continue.
- A transform's returned string follows `data-sse-format`: literal text by default, HTML only when explicitly selected. Transforms never change the CSV payload.

For an event carrying `{"temperature":23.6}`, JSON extraction and the same user function compose directly:

```html
<span data-sse-event="telemetry"
      data-sse-json="/temperature"
      data-sse-transform="celsius_to_degree">—</span>
```

Here the function receives the number `23.6`, rather than the original JSON string. Changing `data-sse-swap` to `append` uses the same transformation before appending.

Do not automatically discover bindings inside incoming fragments. Provide `TurboSSE.refresh()` to rescan when the application deliberately changes its markup. Previously registered event names stay subscribed for capture until destruction; refresh must not create duplicate listeners. Bound elements should not contain other bound elements in the first version, avoiding replacement of active descendant bindings.

**4. Add status and reconnection**

Insert a compact sticky bar at the top of the root:

```text
● Connected   Captured: 1,284   Evicted: 0   [Export CSV]
```

| State | Color | Meaning |
| --- | --- | --- |
| Connecting | Amber | Initial connection attempt |
| Connected | Green | Stream open and within any configured silence timeout |
| Reconnecting | Amber | Recoverable connection loss or watchdog restart |
| Stalled | Red | Configured silence timeout elapsed |
| Disconnected | Red | Terminal closure; automatic retry has stopped |

Use visible text alongside color, an accessible status region, and a keyboard-accessible export button. Announce state transitions, not every received message. Update counters at most once per second. Also expose configuration-error, JSON parse-error, transform-error, and append-drop counts when nonzero.

Let the existing `EventSource` retry while its state is `CONNECTING`; do not start a competing retry loop. Treat `CLOSED` as terminal and offer a Retry button. This respects server shutdown, including HTTP 204, although the API cannot identify the HTTP status for the toolbar. [SSE connection processing](https://html.spec.whatwg.org/multipage/server-sent-events.html#processing-model-5)

The example enables an optional 30-second watchdog. Its server must send a complete `heartbeat` event, as above, at least every 10 seconds while idle. Any captured message resets the timer. On timeout while open, show Stalled, close the old source, and schedule one replacement after two seconds. Comments cannot serve this watchdog because the browser does not deliver them to JavaScript. [SSE stream interpretation](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)

For watchdog replacement or manual Retry, pass the last received ID as an encoded `lastEventId` query parameter. Native reconnect uses `Last-Event-ID`; firmware should prefer that header over the query fallback. A reboot-specific prefix, as in `boot42:101`, distinguishes ID sequences across device restarts. A small firmware replay buffer is optional; otherwise send a fresh value snapshot on every connection. Reconnection alone cannot recover messages lost while disconnected, and the client should not claim exactly-once delivery.

Expose a small imperative API for host-page integration: `TurboSSE.refresh()`, `TurboSSE.exportCSV()`, and `TurboSSE.destroy()`. Destroy closes the stream and releases timers, listeners, pending renders, captured data, and the generated toolbar.

**5. Capture messages independently of rendering**

As confirmed, “raw stream” means each message's original `MessageEvent.data`, before JSON parsing, user transforms, formatting, or DOM coalescing. Capture every message of a registered event type, including heartbeats, capture-only events, and malformed JSON, subject to the retention limits. Never reserialize a parsed JSON value or a transform result into the capture record. This is an event log; SSE comments and wire framing are outside its scope.

Use a ring buffer limited by both event count and string storage. Account for retained strings at two bytes per UTF-16 code unit, including event names and IDs; the budget is an accounting bound, not an exact JavaScript heap measurement. Evict oldest whole records when a limit is reached, and report evictions. If a single record exceeds the buffer budget, omit it whole and report an oversized-record drop rather than silently truncating it.

Export a chronological snapshot of retained records with these columns:

```csv
received_at,elapsed_ms,event,last_event_id,data
2026-09-24T12:00:00.000Z,1250.4,temperature,boot42:101,23.6
2026-09-24T12:00:00.020Z,1270.4,log,boot42:102,"Motor started
"
2026-09-24T12:00:00.040Z,1290.4,telemetry,boot42:103,"{""rpm"":1450,""voltage"":12.4}"
```

`received_at` is browser wall-clock time; `elapsed_ms` uses a monotonic clock from library startup. `last_event_id` is the browser's resume cursor, which may be inherited from a previous event. Keep IDs as strings. Quote CSV fields correctly for commas, quotes, and embedded newlines, and preserve payload text without parsing and reserializing it. Build the CSV only on export, download via a Blob URL, then revoke that URL after initiating the download. Export should neither clear capture nor stop the connection.

The quoted log field above contains a real newline. The JSON field retains the original JSON text, with only CSV quote escaping applied. Export covers the retained window; the toolbar must make eviction/drop counts visible so users can tell when earlier data is no longer available.

**6. Bound work as well as storage**

- Scan attributes once and index bindings in a `Map` keyed by event name. Route raw strings without JSON parsing; parse JSON at most once when requested. Visit only matching bindings and avoid document-wide queries on receipt.
- Cache transform function references alongside bindings. No transform lookup or transformation work is needed for bindings without the attribute. User callback cost remains part of the receive path, so include transforms in performance measurements.
- Capture before coalescing. For replacement targets, keep only the latest pending value and apply it on the next animation frame. The CSV still retains intermediate messages within its buffer limits.
- Append in received order using a `DocumentFragment`. Bound pending and displayed entries together, evict oldest entries on overflow, and report append drops separately from capture evictions.
- Schedule animation frames only while work is pending. Hidden tabs can pause rendering without allowing pending queues to grow indefinitely.
- Skip unchanged text replacements and avoid layout reads in the receive path. Optional auto-scroll is deferred from the first version.
- Keep firmware output bounded: limit frame sizes, send changed values, and choose a sustainable rate. Client batching reduces DOM work but cannot eliminate network and JSON-parsing costs.

**7. Implement and verify in four steps**

1. Implement the connection root, event subscriptions, indexed bindings, text replacement/append, opt-in JSON extraction, user-defined transforms, HTML mode, and cleanup. Add a small demo server with raw values, logs, and occasional JSON telemetry, plus a user-owned transform example.
2. Add the topbar, native reconnect states, optional heartbeat watchdog, and resume-query contract.
3. Add bounded capture, CSV export, eviction/drop counters, and the small public API.
4. Minify, measure asset sizes, and verify behavior in Chromium, Firefox, and WebKit. Document the firmware endpoint contract and package the standalone assets with the demo.

Verification should cover replace/append behavior, literal text versus HTML, multiple bindings per event, raw strings that resemble JSON, mixed raw/JSON bindings, invalid JSON, missing paths, escaped JSON Pointer keys, Unicode/multiline data, CSV round trips, capture-only event subscriptions, retention limits, watchdog cleanup, network drops, reboot/reconnect, terminal closure, and repeated initialization/destruction. Use a real SSE test endpoint for connection behavior.

Transform verification should cover raw-string and typed-JSON inputs, both swap modes, per-message invocation before batching, null/undefined results, missing functions, refresh after registration, thrown errors, unsupported/async results, text versus HTML output, transformed append-size limits, and unchanged raw CSV capture.

Benchmark 100 bindings and 1,000 small messages/second for a 10-minute session, plus a hidden-tab interval. Run raw-only and mixed raw/JSON cases separately, with and without a simple user transform. Record the browser, hardware, message sizes, receive/parse/transform cost, render-flush duration, heap trend, and drop counts. Initial goals are bounded memory after buffers fill and render flushes below 8 ms at the 95th percentile on the documented test machine. These are validation targets, not throughput guarantees for every debugging client.
