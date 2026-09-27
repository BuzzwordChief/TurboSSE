# TurboSSE: graphing and offline inspection

Status: implemented. README.md documents the shipped interface; VALIDATION.md records verification and limits. The current complete bundle exceeds the soft 8 KiB target, with an 18 KiB regression ceiling.

## 1. What we are building

Let users graph values as easily as they display them, inspect several hours of measurements, and export the retained data for offline analysis. Build a purpose-built Canvas 2D renderer directly into TurboSSE, with a scientific appearance and a **soft target of 8 KiB gzip for the complete JavaScript and CSS**.

Keep the model simple:

- **Raw events:** preserve the existing original-payload capture and CSV export, enabled by default.
- **Time series:** graph and export the same numeric history; keep exact samples until memory pressure requires older data to be summarized.
- **Uptime:** synchronize from one configurable plain numeric event, display it in the toolbar, and use the agreed reconnect heuristic for restart markers.

Pages must work directly over ordinary HTTP. Full-session raw-stream recording remains an external workflow such as `nc`. No browser disk recording, companion service, plotting dependency, or new raw/analysis mode is part of this feature.

## 2. HTML and data flow

```html
<body data-sse-connect="/events"
      data-sse-uptime-event="uptime"
      data-sse-omit-raw="temperature telemetry">
  <span data-sse-event="temperature">—</span>

  <div data-sse-event="temperature"
       data-sse-graph
       data-sse-label="Temperature"
       data-sse-unit="°C"></div>

  <div data-sse-graph data-sse-sync="motor">
    <span data-sse-event="telemetry" data-sse-json="/inlet"
          data-sse-label="Inlet" data-sse-unit="°C">—</span>
    <span data-sse-event="telemetry" data-sse-json="/outlet"
          data-sse-label="Outlet" data-sse-unit="°C">—</span>
  </div>

  <div data-sse-event="telemetry" data-sse-json="/rpm"
       data-sse-graph data-sse-sync="motor"
       data-sse-label="Motor speed" data-sse-unit="rpm"></div>
</body>
```

The omission list above is optional. **Without it, all subscribed events are eligible for raw capture, including graphed measurements and uptime.** Use the normalized attribute name `data-sse-omit-raw`, with whitespace-separated, exact event names; absent or empty means omit nothing. It removes an entire event payload from raw capture, including any unplotted JSON fields. It does not unsubscribe, suppress bindings, change graph history, skip uptime synchronization, or affect liveness and reconnect cursors. No wildcard or automatic omission. Root capture options are read at initialization, as today.

```text
One SSE receive path
  ├─ original payload, unless explicitly omitted → raw ring → raw-events.csv
  ├─ select / numeric transform → shared series history → graphs + one CSV per series
  └─ configured uptime event → clock estimate → toolbar + plot/export timing
```

Reuse the existing event registry, JSON Pointers, numeric transforms and animation scheduling. Parse JSON at most once per message. Raw capture remains independent of parsing/transform failures. Explicit omission still applies when a transform fails; errors must not silently re-enable raw capture. Count intentional omissions separately from memory evictions.

Identical numeric sources can share one history across plot views and export. A source is its event, selector, resolved numeric transform and unit. Graph transforms must be pure; existing ordinary text/append transform semantics remain unchanged. A numeric graph transform runs before display formatting. Unit-bearing strings such as `"23.6 °C"` belong in text bindings; graphs use a number plus `data-sse-unit`.

Grouped plot containers have no event binding of their own; their child bindings define the series. Preserve those author-owned elements when generating chart DOM. Single-series graph hosts remain leaf bindings. Use one y-unit per panel; quantities with different units go in synchronized stacked panels.

| Attribute | Purpose |
| --- | --- |
| `data-sse-graph` | Graph a binding, or group several series into one plot. |
| `data-sse-label`, `data-sse-unit` | Measurement name and unit. |
| `data-sse-sync` | Link time navigation and cursors across plots. |
| `data-sse-window` | Initial/Live visible seconds; default 60. Does not determine retention. |
| `data-sse-y-min`, `data-sse-y-max` | Optional fixed y-axis bounds. |
| Root `data-sse-omit-raw` | Event names excluded only from raw capture; default none. |
| Root `data-sse-uptime-event` | Numeric uptime event name; default `uptime`. |
| Root `data-sse-graph-bytes` | Graph history/index/clock budget; initial target 32 MiB, allocated as needed. |

Keep existing event-buffer limits and all other binding attributes. Use CSS for plot height, width and restrained color customization.

## 3. Export exactly the retained data behind the interface

**Export CSV** offers one raw-event file and one file per unique time series. Several views of the same series produce one series file. All files from an export share a timestamp prefix and describe one consistent snapshot. Export all retained history by default, including series hidden in the legend. A per-plot selection export can restrict the series interval explicitly.

Example files:

```text
2026-09-27T120000-raw-events.csv
2026-09-27T120000-s01-temperature.csv
2026-09-27T120000-s02-inlet.csv
2026-09-27T120000-s03-outlet.csv
2026-09-27T120000-s04-motor-speed.csv
```

Use safe, unique names derived from series labels plus stable local identifiers. On pages without graphs, the button retains its current raw CSV download behavior. With graphs, it opens a small file list with individual download links. This avoids introducing an archive format or download dependency. Retain `TurboSSE.exportCSV()` as the current raw-snapshot API; series export is available through the UI without adding a second export-mode API.

**Raw-event file:** keep the existing schema and original strings:

```text
received_at,elapsed_ms,event,last_event_id,data
```

Only CSV escaping is applied. Existing ring limits remain: by default 10,000 events and 2 MiB of accounted strings, evicting oldest records when full. Omitted or evicted events cannot be reconstructed from numeric series. Preserve JSON formatting, leading zeros, multiline data, diagnostic messages, and payloads that fail transformation whenever they are retained in the ring.

**Series files:** export the actual numeric values used by the graph, after numeric transforms but before display rounding. Read the retained history, never the screen-resolution drawing output. Include the label, unit and source event/selector/transform as metadata columns so each CSV is understandable on its own.

Use a fixed series schema with these fields:

- `series,event,json_pointer,transform,unit` identify the measurement.
- `kind` is `sample`, `summary`, `gap`, or `restart`.
- `elapsed_start_s,elapsed_end_s` locate a point or interval on the shared browser timeline.
- `uptime_start_s,uptime_end_s,segment` preserve estimated device time and local restart context; unknown uptime is empty, never zero by default.
- `value,count,min,max,mean,stddev,first,last,min_elapsed_s,max_elapsed_s,gaps` preserve the plotted numeric data and its retained statistics.

For a sample, start/end times coincide, `value` is the stored number, and `count` is 1. For a summary, leave `value` empty and export the interval, count and aggregates; do not disguise its mean as an original measurement. Gap/restart rows carry timing/context without numeric measurements. Restart rows are explicitly estimated markers, not device-confirmed events. Include the marker/context required to interpret the selected history even if its detection is outside the selected interval.

“Compressed” history means statistical summaries in ordinary CSV, not a proprietary encoding or file compression. The exported precision matches what the UI can inspect. It does not recover original samples already compacted away. Raw and series files may cover different retained durations; show their coverage and resolution in the export list.

Create a consistent snapshot before preparing downloads. Build files in bounded work slices so reception continues; account for snapshot references, output Blobs and scratch memory in an explicit temporary budget. Release pinned history as files are prepared and revoke download URLs when the export is replaced or closed. Allow only one prepared export at a time. If the snapshot cannot fit the export budget, report that before offering partial results and let the user select a smaller interval. Do not silently downsample further during export.

## 4. Keep hours of useful graph history

Use reusable typed-array chunks for timestamps and values, with compact shared timing/source metadata. Avoid per-sample objects, shifting arrays, or copying whole histories during redraw. Multiple views and exports read the same stored series. The graph budget includes summaries, indexes and clock metadata; browser/canvas overhead is additional and must be measured.

There is no age-based expiry of raw samples. Keep them exact while space permits. When the budget fills, compact the oldest blocks into summaries and progressively merge older summaries as needed. Preserve:

- Time coverage, first/last values and valid sample count.
- Minimum/maximum values and their original times.
- Sample-weighted mean and a stable mergeable deviation accumulator for standard deviation/RMS.
- Gap information and inferred restart boundaries.

Merge means using counts, not by averaging averages equally. Do not merge ordinary summaries across inferred restart boundaries or draw uninterrupted lines across known gaps. Prefer coarser historical coverage over deleting it. Keep metadata bounded too; if its minimum state cannot fit, expire the oldest complete historical segment with explicit coverage accounting.

Perform compaction incrementally during ingestion, independent of animation callbacks. Distinguish storage compaction from temporary drawing reduction: rendering may use fewer points without changing exportable history. Query visible ranges through indexes and choose first/min/max/last or envelopes appropriate to pixel width, preserving spikes. Drawing work should scale mainly with visible width and series count, not all previously received samples.

Use eight channels at 100 Hz for eight hours as the reference workload: **23.04 million values**, about **352 MiB** for timestamp/value pairs alone if all stayed raw. Measure that workload against the bounded design rather than promising a fixed exact-history duration for every data rate.

## 5. Scientific appearance and inspection

Use a white background, charcoal labels, fine gray grid, restrained distinguishable lines, readable units and tabular readouts. Straight segments and explicit min/max envelopes communicate the data; avoid decorative fills, curve smoothing and animated transitions. Handle negative, constant, very small and very large signals with sensible axes and scientific notation.

Ship these features together:

- Multiple overlaid series with legend hide/show/isolate, plus synchronized stacked panels for different units.
- Crosshair readouts, pointer-anchored zoom, interval zoom, pan, Fit Y, Fit history, Live follow and bounded zoom-back history.
- A/B cursors for delta time/value and interval statistics: count, extrema, peak-to-peak, mean, RMS and population standard deviation.
- Clear gaps, estimated restart markers, exact/summary resolution, and approximate or unknown device time.
- Responsive/high-DPI rendering, accessible value readouts and keyboard/touch controls.

Inspection does not stop acquisition, and incoming samples do not undo a user's zoom. A compact DOM overlay handles cursors/selection without redrawing all traces. Batch live trace drawing at about 20–30 fps and skip hidden panels while maintaining their buffers.

Statistics use retained numeric data, not display rounding or drawing reductions. If a selected boundary cuts through an old summary whose samples are gone, show the effective whole-bucket statistical interval rather than claiming unavailable precision. Never interpolate silently across gaps or infer an exact sample value from an old summary.

## 6. Simple uptime in the toolbar and plots

The target sends a plain finite, nonnegative float in **seconds**, once or periodically:

```text
event: uptime
data: 1234.567

```

`data-sse-uptime-event` changes the name. Subscribe automatically and parse only the number; no JSON clock payload, device identifier, or per-measurement device timestamp is required. Invalid reports leave the last valid anchor intact.

Estimate uptime from the latest report and local monotonic elapsed time:

```text
uptime_s = reported_uptime_s + (browser_now_ms - report_received_ms) / 1000
```

Show **Uptime ≈HH:MM:SS** in the toolbar, updating through the existing one-second timer. Show `Uptime —` before the first report. Mark the estimate unsynchronized while disconnected or awaiting the first valid report after reconnect. Periodic reports resynchronize it without adding restart markers. Preserve historical sample-time context so later reports do not silently retimestamp earlier data.

After reconnect, compare the first valid new uptime with the last **reported** value from before disconnection. If `uptime_last > uptime_now`, infer a restart, keep previous history and add an estimated marker. Initial connection and equal/higher values do not imply a restart. A decrease during an uninterrupted connection only corrects the clock estimate under this deliberately simple rule.

The marker's estimated position is `report_elapsed_ms - uptime_s * 1000`; retain detection time as context. Device/network buffering and clock drift make this approximate. Accept that a restart can be missed if its new uptime already exceeds the last value seen. No more elaborate detection protocol is required.

Omitting the uptime event from raw capture must not disable toolbar synchronization or timing in series exports. Raw CSV otherwise includes its original payload normally.

## 7. Implementation sequence and acceptance

1. **Storage and binding foundation:** add explicit raw omission, shared numeric histories and pressure-driven compaction. Preserve one SSE connection and existing text/log behavior. Measure gzip size early.
2. **Graphs and inspection:** implement Canvas axes/traces, overlays, stacked synchronization, navigation and statistical readouts with the scientific styling.
3. **Uptime:** add configurable numeric synchronization, toolbar display and the agreed reconnect restart heuristic; retain its context with graph data.
4. **Separate CSV exports:** preserve raw CSV, add one self-contained CSV per series, and build the bounded snapshot/file-list workflow. Verify output against the same histories used for plots and statistics.
5. **Validation and documentation:** update examples, README, build budgets, tests and measured validation results. Keep the existing Python-only build, asset names, gzip variants and C headers.

Acceptance checks:

- Raw capture remains enabled by default for graphed and ungraphed events. Omission affects only raw storage; test multiple names, an empty list, uptime, invalid JSON and transform failures. Existing CSV escaping and API guarantees remain intact.
- Plots and their files use the same source data. Test individual samples, summaries, gap/restart rows, transformed units, multiple views of one series, stable filenames and snapshot consistency while new data arrives.
- Reference calculations verify count-weighted means, variance, extrema/timestamps and no double counting through repeated compaction. A single narrow spike survives as an extremum. Raw samples remain exact while memory permits.
- Toolbar uptime advances from one report, resynchronizes with later reports, stays unknown before synchronization, and uses the last reported value for the first post-reconnect comparison. Test malformed values and the accepted missed-restart case.
- Chromium, Firefox and WebKit cover ordinary HTTP, navigation, export downloads, resize/high-DPI, keyboard/touch, hidden tabs, refresh, removal and destroy/reinit. Release buffers, observers and handlers without duplicate connections.
- Simulate the eight-hour reference workload using bounded generators, then run live SSE/graph checks with periodic exports, capped at 30 minutes as requested. Measure retained memory, compaction/query time and interaction latency. Target responsive cursors, ordinary pan/zoom within 50 ms, and at least 20 live redraws/second for four visible panels on the recorded reference machine.
- Measure complete compressed size at each milestone. The current baseline is **4,438 gzip bytes**; prioritize shared code and the focused scope to approach 8 KiB, reporting any justified overage. Verify deterministic builds and exact C/C++ embedded-asset round trips.

The result should have one clear export workflow: original events in their existing CSV, each plotted series in its own CSV, and enough timing/statistical context to inspect the retained data offline.
