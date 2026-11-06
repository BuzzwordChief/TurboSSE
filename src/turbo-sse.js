/* TurboSSE: attribute-driven Server-Sent Events. See README.md. */
(() => {
  "use strict";
  if (window.TurboSSE) return;

  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const attr = (element, name) => element.getAttribute("data-sse-" + name);
  const APPEND_BYTES = 262144;
  let active = null;

  // Both capture and append queues use a bounded circular buffer: no Array.shift().
  class Ring {
    constructor(limit, budget) {
      this.limit = limit;
      this.budget = budget;
      this.items = [];
      this.head = this.size = this.bytes = 0;
    }
    push(item, evict) {
      if (item.bytes > this.budget) return false;
      while (this.size >= this.limit || this.bytes + item.bytes > this.budget) {
        const old = this.items[this.head];
        this.items[this.head] = undefined;
        this.head = (this.head + 1) % this.limit;
        this.size--;
        this.bytes -= old.bytes;
        evict(old);
      }
      this.items[(this.head + this.size) % this.limit] = item;
      this.size++;
      this.bytes += item.bytes;
      return true;
    }
    each(fn) {
      for (let i = 0; i < this.size; i++) fn(this.items[(this.head + i) % this.limit]);
    }
  }

  function number(element, name, fallback, minimum) {
    const raw = attr(element, name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(value) || value < minimum) {
      throw new Error("Invalid data-sse-" + name);
    }
    return value;
  }

  function numeric(value) {
    if (typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) value = Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : NaN;
  }

  function pointer(path) {
    if (path === null) return null;
    if (path === "") return [];
    if (!path.startsWith("/") || /~(?![01])/.test(path)) throw new Error("Invalid JSON Pointer");
    return path.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  }

  function select(value, path) {
    for (const key of path) {
      if (value === null || typeof value !== "object" || !own(value, key)) return undefined;
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      value = value[key];
    }
    return value;
  }

  function normalize(value) {
    if (value === undefined) return undefined;
    if (value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return String(value);
    if (typeof value === "object") {
      if (typeof value.then === "function") {
        // Observe rejections without accepting asynchronous rendering or reordering events.
        Promise.resolve(value).catch(() => {});
      } else if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
        const result = JSON.stringify(value);
        if (result !== undefined) return result;
      }
    }
    throw new Error("Unsupported transform result");
  }

  // Aggregate: start/end time, start/end uptime, segment, count, min, max,
  // mean, population deviation, first/last value, min/max time, gaps, records.
  const FIELDS = 16, BLOCK = 128, NODE_BYTES = 256, DATA_BYTES = BLOCK * 3 * 8;
  function sample(a, t, u, y, segment) {
    if (!a[15]) { a[0] = t; a[2] = u; a[4] = segment; a[6] = Infinity; a[7] = -Infinity; a[10] = a[11] = NaN; }
    a[1] = t; a[3] = u; a[15]++;
    if (!Number.isFinite(y)) { a[14]++; return a; }
    const n = ++a[5], delta = y - a[8], weight = (n - 1) / n;
    if (n === 1) { a[8] = y; a[9] = 0; }
    else {
      // Store deviation rather than its square to avoid variance overflow and
      // underflow for finite signals near the ends of Float64's range.
      const correction = Number.isFinite(delta) ? delta * Math.sqrt(weight) / Math.sqrt(n) : (y / n - a[8] / n) * Math.sqrt(n - 1);
      a[9] = Math.hypot(a[9] * Math.sqrt(weight), correction);
      a[8] = Number.isFinite(delta) ? a[8] + delta / n : a[8] * weight + y / n;
    }
    if (n === 1) a[10] = y;
    a[11] = y;
    if (y < a[6]) { a[6] = y; a[12] = t; }
    if (y > a[7]) { a[7] = y; a[13] = t; }
    return a;
  }

  function combine(a, b) {
    const c = a.slice(), n = a[5] + b[5], delta = b[8] - a[8];
    c[1] = b[1]; c[3] = b[3]; c[4] = a[4] === b[4] ? a[4] : -1;
    c[5] = n;
    if (!a[5]) { c[8] = b[8]; c[9] = b[9]; c[10] = b[10]; }
    else if (b[5]) {
      const p = a[5] / n, q = b[5] / n, weight = Math.sqrt(p * q);
      c[8] = Number.isFinite(delta) ? a[8] + delta * q : a[8] * p + b[8] * q;
      c[9] = Math.hypot(a[9] * Math.sqrt(p), b[9] * Math.sqrt(q), Number.isFinite(delta) ? delta * weight : b[8] * weight - a[8] * weight);
    }
    if (b[5]) c[11] = b[11];
    if (b[6] < a[6]) { c[6] = b[6]; c[12] = b[12]; }
    if (b[7] > a[7]) { c[7] = b[7]; c[13] = b[13]; }
    c[14] += b[14]; c[15] += b[15];
    return c;
  }

  // Balanced forest of immutable sealed chunks. Index nodes become coarse
  // history when pressure releases their children. Recent samples stay exact.
  class History {
    constructor(limit) {
      this.limit = limit;
      this.roots = [];
      this.current = null;
      this.levels = new Uint32Array(64);
      this.temp = new Float64Array(FIELDS);
      this.bytes = 512;
      this.raw = this.compacted = this.evicted = 0;
    }
    resize(limit) { this.limit = limit; this.reserve(0); }
    release(node, bytes) {
      this.bytes -= bytes;
      for (let n = node; n; n = n.parent) n.bytes -= bytes;
    }
    reduce(node, force) {
      if (node.data) {
        node.data = null;
        this.raw -= node.a[15];
        this.compacted += node.a[15];
        this.levels[node.level]++;
        this.release(node, DATA_BYTES);
        return true;
      }
      const l = node.left, r = node.right;
      if (!l) return false;
      if (!l.data && !r.data && !l.left && !r.left && node.a[4] >= 0 && (force || this.levels[l.level] > 32)) {
        this.levels[l.level] -= 2;
        this.levels[node.level]++;
        this.release(node, l.bytes + r.bytes);
        node.left = node.right = null;
        return true;
      }
      return this.reduce(l, force) || this.reduce(r, force);
    }
    reserve(need) {
      while (this.bytes + need > this.limit) {
        if (this.roots.some(n => this.reduce(n, false)) || this.roots.some(n => this.reduce(n, true))) continue;
        const old = this.roots.shift();
        if (!old) throw new Error("Graph budget too small");
        const forget = n => {
          if (n.data) this.raw -= n.a[15];
          else if (!n.left) this.levels[n.level]--;
          if (n.left) { forget(n.left); forget(n.right); }
        };
        forget(old);
        this.bytes -= old.bytes;
        this.evicted += old.a[15];
      }
    }
    seal() {
      if (!this.current) return;
      this.roots.push(this.current);
      this.current = null;
      while (this.roots.length > 1) {
        const end = this.roots.length;
        if (this.roots[end - 1].level !== this.roots[end - 2].level) break;
        this.reserve(NODE_BYTES);
        if (this.roots.length < 2) break;
        const r = this.roots.pop(), l = this.roots.pop();
        const n = {a: combine(l.a, r.a), left: l, right: r, level: l.level + 1, bytes: l.bytes + r.bytes + NODE_BYTES};
        l.parent = r.parent = n;
        this.bytes += NODE_BYTES;
        this.roots.push(n);
      }
    }
    add(t, u, y, segment) {
      if (this.current && (this.current.a[15] === BLOCK || this.current.a[4] !== segment)) this.seal();
      if (!this.current) {
        this.reserve(DATA_BYTES + NODE_BYTES);
        this.current = {a: new Float64Array(FIELDS), data: new Float64Array(BLOCK * 3), level: 0, bytes: DATA_BYTES + NODE_BYTES};
        this.bytes += this.current.bytes;
      }
      const n = this.current, offset = n.a[15] * 3;
      n.data[offset] = t; n.data[offset + 1] = u; n.data[offset + 2] = y;
      sample(n.a, t, u, y, segment);
      this.raw++;
    }
    query(lo, hi, pixels, visit, aggregate = false) {
      const step = pixels ? (hi - lo) / pixels : 0;
      const walk = n => {
        const a = n.a;
        if (a[1] < lo || a[0] > hi) return;
        if (!n.data && !n.left) { visit(a, true); return; }
        if (lo <= a[0] && a[1] <= hi && (aggregate || (pixels && a[1] - a[0] <= step * 2))) { visit(a, false); return; }
        if (n.left) { walk(n.left); walk(n.right); return; }
        this.temp.fill(0);
        let column = -Infinity;
        for (let i = 0; i < a[15] * 3; i += 3) {
          const t = n.data[i];
          if (t < lo || t > hi) continue;
          const next = pixels ? Math.floor((t - lo) / step) : i;
          if (this.temp[15] && next !== column) { visit(this.temp, false); this.temp.fill(0); }
          sample(this.temp, t, n.data[i + 1], n.data[i + 2], a[4]);
          column = next;
        }
        if (this.temp[15]) visit(this.temp, false);
      };
      this.roots.forEach(walk);
      if (this.current) walk(this.current);
    }
    range(lo = -Infinity, hi = Infinity) {
      let value = null;
      this.query(lo, hi, 0, a => { value = value ? combine(value, a) : a.slice(); }, true);
      return value;
    }
    nearest(t, past = false) {
      let found = null, distance = Infinity;
      for (const n of [...this.roots, this.current]) {
        if (!n) continue;
        if (past) { if (n.a[0] <= t) found = n; continue; }
        const d = Math.max(n.a[0] - t, t - n.a[1], 0);
        if (d <= distance) { found = n; distance = d; }
      }
      if (!found) return null;
      while (found.left) found = t < (past ? found.right.a[0] : (found.left.a[1] + found.right.a[0]) / 2) ? found.left : found.right;
      if (!found.data) return {a: found.a, summary: true};
      const data = found.data;
      let lo = 0, hi = found.a[15];
      while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid * 3] <= t) lo = mid + 1; else hi = mid; }
      let i = Math.max(0, lo - 1);
      if (!past && lo < found.a[15] && data[lo * 3] - t < t - data[i * 3]) i = lo;
      const a = sample(new Float64Array(FIELDS), data[i * 3], data[i * 3 + 1], data[i * 3 + 2], found.a[4]);
      return {a, summary: false};
    }
    *rows(lo = -Infinity, hi = Infinity) {
      const walk = function* (n) {
        if (!n || n.a[1] < lo || n.a[0] > hi) return;
        if (n.left) { yield* walk(n.left); yield* walk(n.right); }
        else if (!n.data) yield {a: n.a, summary: true};
        else {
          const a = new Float64Array(FIELDS);
          for (let i = 0; i < n.a[15] * 3; i += 3) {
            if (n.data[i] < lo || n.data[i] > hi) continue;
            a.fill(0);
            yield {a: sample(a, n.data[i], n.data[i + 1], n.data[i + 2], n.a[4]), summary: false};
          }
        }
      };
      for (const n of this.roots) yield* walk(n);
      yield* walk(this.current);
    }
    copy(lo = -Infinity, hi = Infinity) {
      const h = new History(this.limit);
      const clone = n => {
        if (!n || n.a[1] < lo || n.a[0] > hi) return null;
        const left = clone(n.left), right = clone(n.right);
        if (n.left && (!left || !right)) return left || right;
        h.bytes += NODE_BYTES + (n.data ? n.data.byteLength : 0);
        return {a: n.a.slice(), level: n.level, bytes: n.bytes, data: n.data && n.data.slice(), left, right};
      };
      h.roots = this.roots.map(clone).filter(Boolean); h.current = clone(this.current);
      return h;
    }
  }

  // Series colors for thin lines on black; every pair stays distinct with red-green color blindness.
  // Red and orange are left to restart markers and the selection.
  const palette = ["#fcd936", "#46d8fc", "#f85fbd", "#55cd7a", "#749ff9", "#995df7"];
  const tint = c => palette[(c.id - 1) % palette.length];
  // The canvas uses the interface's monospaced face. Text is centered on its capitals: mid is where the middle of a
  // capital letter goes. Centered text is placed by its ink, which engines position differently from its advance.
  const SMALL = 'bold 10px ui-monospace, "Cascadia Mono", Menlo, Consolas, "Roboto Mono", "DejaVu Sans Mono", monospace', LARGE = SMALL.replace(10, 11);
  const centered = (ctx, text, x, mid) => {
    const ink = ctx.textAlign == "center" ? ctx.measureText(text) : null;
    ctx.fillText(text, ink ? x - (ink.actualBoundingBoxRight - ink.actualBoundingBoxLeft) / 2 : x, mid + ctx.measureText("H").actualBoundingBoxAscent / 2);
  };
  const format = value => {
    if (!Number.isFinite(value)) return "—";
    const magnitude = Math.abs(value);
    return magnitude && (magnitude >= 1e6 || magnitude < .001) ? value.toExponential(4).replace(/\.?0+e/, "e") : String(Number(value.toPrecision(5)));
  };
  const put = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const pair = (label, value) => ` <span>${label} <b>${value}</b></span>`;
  // Discrete lanes. A well-mixed hash of a value's text picks two of 24 colors: eight hue families of equal
  // perceived lightness, each in three dark tints that keep white text readable, outlined in a bright tone of the
  // hue. No family is red or orange.
  // The second color always has another hue.
  // A value takes its first color unless another value in the same lane already has that hue or that color.
  const LANE = 20, HUES = [100, 125, 150, 180, 215, 255, 295, 330];
  const choices = text => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909); h = (h ^ h >>> 16) >>> 0;
    const first = h % 24;
    return [first, (h >>> 16) % 3 * 8 + (first % 8 + 1 + (h >>> 20) % 7) % 8];
  };
  const shade = (slot, fill) => `oklch(${fill ? [.3, .37, .44][slot >> 3] + " .08" : ".8 .14"} ${HUES[slot % 8]})`;
  // Shorten text with an ellipsis to fit a width in pixels; empty when nothing fits.
  const clip = (ctx, text, room) => {
    const width = ctx.measureText(text).width, keep = Math.floor(text.length * room / width) - 1;
    return width <= room ? text : keep > 0 ? text.slice(0, keep) + "…" : "";
  };
  const typing = event => event.target.closest && event.target.closest("input:not([type=checkbox]), textarea, select, [contenteditable]");
  function make(tag, className, text, parent) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.append(node);
    return node;
  }
  function option(element, name, fallback) {
    const raw = attr(element, name), value = raw === null ? fallback : numeric(raw);
    if (value !== null && !Number.isFinite(value)) throw new Error("Invalid data-sse-" + name);
    return value;
  }
  function ticks(lo, hi, count) {
    const scale = Math.max(Math.abs(lo), Math.abs(hi), Number.MIN_VALUE);
    const desired = Math.max(Number.MIN_VALUE, (hi / scale - lo / scale) / count * scale);
    const base = Math.max(Number.MIN_VALUE, Math.pow(10, Math.floor(Math.log10(desired))));
    const step = [1, 2, 5, 10].find(v => v * base >= desired) * base;
    const values = [];
    if (!Number.isFinite(step) || step <= 0) return values;
    for (let v = Math.ceil(lo / step) * step; v <= hi && values.length < 20; v += step) values.push(v);
    return values;
  }

  class Plot {
    constructor(host, sources, view, hooks) {
      this.host = host; this.sources = sources; this.view = view; this.hooks = hooks;
      this.min = option(host, "y-min", null); this.max = option(host, "y-max", null);
      if (this.min !== null && this.max !== null && this.min >= this.max) throw new Error("Graph y-min must be below y-max");
      this.hidden = new Set(); this.top = 24; this.left = 64; this.width = this.height = this.span = 1; this.pointer = null; this.chip = "";
      this.lanes = sources.filter(c => c.lane); this.series = sources.filter(c => !c.lane);
      this.abort = new AbortController();
      const listen = (node, name, fn, opts = {}) => node.addEventListener(name, fn, {...opts, signal: this.abort.signal});
      const title = this.title = attr(host, "title") || attr(host, "label") || sources.map(c => c.label).join(", ");
      this.element = make("section", "turbo-sse-plot", undefined, host);
      this.element.setAttribute("aria-label", title);
      const header = make("header", "", undefined, this.element);
      make("strong", "", title, header);
      // An enlarged plot pages through the plots from its title bar, as a menu page does: ‹ 2/4 ›.
      this.pager = make("nav", "", undefined, header); this.pager.setAttribute("aria-label", "Plots");
      [-1, 1].forEach(step => {
        const b = make("button", "", step < 0 ? "‹" : "›", this.pager); b.type = "button"; b.setAttribute("aria-label", step < 0 ? "Previous plot" : "Next plot");
        listen(b, "click", event => { event.stopPropagation(); hooks.page(step); });
        if (step < 0) this.page = make("output", "", undefined, this.pager);
      });
      make("span", "", this.units = [...new Set(sources.map(c => c.unit).filter(Boolean))].join(", "), header);
      // Pressing the header of the active plot enlarges it, as entering a selected menu row; pressing it again
      // brings the plot back. Selecting the header's text does neither.
      listen(header, "pointerdown", () => { this.armed = this.active; });
      listen(header, "click", () => { if (this.armed && getSelection().isCollapsed) hooks.enlarge(this); });
      // The band above the data holds the plot controls only: equal keys, each with its key glyph.
      this.tools = make("div", "turbo-sse-tools");
      this.controls = make("div", "", undefined, this.tools); this.controls.setAttribute("role", "toolbar");
      const live = make("label", "", undefined, this.controls);
      this.liveBox = make("input", "", undefined, live); this.liveBox.type = "checkbox"; this.liveBox.dataset.action = "Live"; make("span", "", "Live", live); make("kbd", "", "L", live);
      listen(this.liveBox, "change", () => this.live(this.liveBox.checked));
      // The last button enlarges the plot to fill the window; it then reads Reduce.
      for (const [action, key] of [["Fit", "F"], ["Back"], ["Export view"], ["Enlarge", "E"]]) {
        const b = this.full = make("button", "", undefined, this.controls); b.type = "button"; b.dataset.action = action;
        make("span", "", action, b);
        if (key) make("kbd", "", key, b);
      }
      this.area = make("div", "turbo-sse-area", undefined, this.element);
      this.area.append(this.tools);
      this.canvas = make("canvas", "", undefined, this.area);
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute("role", "img");
      this.canvas.setAttribute("aria-label", title + ". Click to interact. Drag or arrow keys pan; wheel, + and − zoom; right-drag zooms a range; Shift-drag measures; A and B place markers; Esc clears; L live; F fit; E enlarge; J jump to a plot.");
      // The gutter fits the unit, the lane names and, once drawn, the y labels. Lanes add rows below the numeric
      // area, or make up the whole plot.
      const pen = this.pen = this.canvas.getContext("2d"); pen.font = SMALL;
      this.unit = this.series.length ? this.series[0].unit : "";
      this.need = Math.ceil(Math.max(18, pen.measureText(this.unit).width + 8, ...this.lanes.map(c => Math.min(120, pen.measureText(c.label).width) + 10)));
      if (this.lanes.length) this.area.style.height = this.series.length ? `calc(var(--turbo-sse-height, 220px) + ${this.lanes.length * LANE}px)` : (this.area.style.flex = "none", 66 + this.lanes.length * LANE + "px");
      // The crosshair carries its time and value as chips on the axes, and a ring marks each curve's nearest sample.
      this.cursor = make("div", "turbo-sse-cursor", undefined, this.area);
      this.horizontal = make("div", "turbo-sse-cross-y", undefined, this.area);
      this.selection = make("div", "turbo-sse-selection", undefined, this.area);
      this.rings = this.series.map(c => { const r = make("i", "turbo-sse-ring", undefined, this.area); r.style.setProperty("--series-color", tint(c)); return r; });
      this.cursor.hidden = this.horizontal.hidden = this.selection.hidden = true;
      // Series tiles, as in a camera's function menu: a numbered badge and the name over the value, between thin
      // rules. The number is the series' export file number (s01, s02, …).
      this.legend = make("div", "turbo-sse-legend", undefined, this.element);
      this.tiles = sources.map(c => {
        // A focusable span rather than a <button>, so its name and value can be selected and copied in every browser.
        const b = make("span", "", undefined, this.legend); b.tabIndex = 0; b.setAttribute("role", "button");
        b.style.setProperty("--series-color", tint(c));
        b.setAttribute("aria-pressed", "true");
        if (c.lane) b.dataset.lane = "";
        listen(b, "keydown", event => { if (event.key == "Enter" || event.key == " ") { event.preventDefault(); b.click(); } });
        make("span", "turbo-sse-series-name", c.label, b).dataset.n = c.id; b.append(" ");
        b.value = make("b", "turbo-sse-series-value", "—", b);
        if (c.unit && !c.lane) b.unit = make("small", "", "", b.value);
        listen(b, "click", event => {
          if (!getSelection().isCollapsed) return;  // Selecting text does not toggle the series.
          if (event.shiftKey) { this.hidden = new Set(sources.filter(s => s !== c)); }
          else if (this.hidden.has(c)) this.hidden.delete(c); else this.hidden.add(c);
          this.tiles.forEach((t, i) => t.setAttribute("aria-pressed", String(!this.hidden.has(sources[i]))));
          hooks.invalidate();
        });
        return b;
      });
      this.readout = make("div", "turbo-sse-readout", "Waiting for data", this.element);
      // The guide and the measurement share one grid cell, so the panel keeps its height and measuring never moves
      // the page. The guide pairs each key glyph with what it does; touch screens list gestures instead.
      this.measure = make("div", "turbo-sse-measure", undefined, this.element);
      this.guide = make("div", "turbo-sse-guide", undefined, this.measure);
      this.guide.innerHTML = '<span><kbd>Drag</kbd> Pan</span><span><kbd class="turbo-sse-sign">←</kbd><kbd class="turbo-sse-sign">→</kbd> Pan</span><span><kbd>Wheel</kbd> Zoom</span><span><kbd class="turbo-sse-sign">+</kbd><kbd class="turbo-sse-sign">−</kbd> Zoom</span><span><kbd>Right-drag</kbd> Zoom range</span><span><kbd>Shift</kbd>+<kbd>Drag</kbd> Measure</span><span><kbd>A</kbd><kbd>B</kbd> Markers</span><span><kbd>Esc</kbd> Clear</span><span><kbd>J</kbd> Jump</span><span data-big><kbd class="turbo-sse-sign">[</kbd><kbd class="turbo-sse-sign">]</kbd> Plots <i></i></span><span data-touch><b>Drag</b> Pan</span><span data-touch><b>Tap</b> Place A</span><span data-touch><b>Tap again</b> Place B</span>';
      this.squares = this.guide.querySelector("i");
      this.result = make("div", "", undefined, this.measure);
      listen(this.controls, "click", event => {
        const target = event.target.closest("[data-action]"), action = target && target.dataset.action;
        if (action == "Fit") { this.save(); this.y = null; const r = hooks.extent(view); if (view.live) view.window = Infinity; else { view.lo = r[0]; view.hi = Math.max(r[1], r[0] + .001); } }
        if (action == "Back" && view.history.length) Object.assign(view, view.history.pop());
        if (action == "Enlarge") hooks.enlarge(this);
        if (action == "Export view") hooks.export(sources, view.a !== null && view.b !== null ? [Math.min(view.a, view.b), Math.max(view.a, view.b)] : [view.lo, view.hi]);
        // After a pointer click, return focus to the canvas so its shortcuts keep working.
        // Keyboard activation shows a focus ring on the control; focus then stays for tabbing.
        if (!(target || event.target).matches(":focus-visible")) this.canvas.focus();
        hooks.invalidate();
      });
      listen(this.canvas, "contextmenu", event => event.preventDefault());
      listen(this.canvas, "wheel", event => {
        if (!this.active) return;
        event.preventDefault();
        this.zoom(this.time(event), Math.exp(Math.max(-1, Math.min(1, event.deltaY / 300))));
      }, {passive: false});
      listen(this.canvas, "pointerdown", event => {
        if (this.drag || (event.button !== 0 && event.button !== 2)) return;
        event.preventDefault();
        const was = this.activate(); this.canvas.focus();
        if (!was) return;
        this.canvas.setPointerCapture(event.pointerId);
        const t = this.track(event);
        this.mode = event.button === 2 ? "Zoom" : event.shiftKey ? "Measure" : "Pan";
        this.drag = {x: event.clientX, y: event.clientY, t, end: t, lo: view.lo, hi: view.hi, live: view.live, a: view.a, b: view.b, fresh: view.a === null || view.b !== null};
        this.save(); view.live = false; hooks.invalidate();
        if (this.mode === "Measure") { if (this.drag.fresh) view.a = this.snap(t); view.b = null; }
      });
      listen(this.canvas, "pointermove", event => {
        const t = this.track(event);
        if (this.drag) {
          const d = this.drag;
          if (this.mode === "Pan") {
            const shift = (event.clientX - d.x) * (d.hi - d.lo) / this.width;
            this.setRange(d.lo - shift, d.hi - shift, false);
          } else if (this.mode === "Measure") { view.b = this.snap(t); hooks.invalidate(); }
          else { d.end = t; hooks.invalidate(); }
        }
        hooks.cursor(view);
      });
      listen(this.canvas, "pointerup", event => {
        if (!this.drag) return;
        const d = this.drag, t = this.time(event), moved = Math.abs(event.clientX - d.x) > 3; this.drag = null;
        if (this.mode === "Measure") view.b = d.fresh && !moved ? null : this.snap(t);
        else if (this.mode === "Zoom" && moved) {
          if (event.shiftKey && this.series.length && Math.abs(event.clientY - d.y) > 3) {
            const rect = this.canvas.getBoundingClientRect();
            this.y = [this.value(Math.max(d.y, event.clientY) - rect.top), this.value(Math.min(d.y, event.clientY) - rect.top)];
          }
          this.setRange(Math.min(d.t, t), Math.max(d.t, t), false);
        } else if (!moved && event.pointerType === "touch") { if (d.fresh) { view.a = this.snap(t); view.b = null; } else view.b = this.snap(t); }
        else if (!moved) { Object.assign(view, {lo: d.lo, hi: d.hi, live: d.live}); view.history.pop(); }
        hooks.invalidate();
      });
      listen(this.canvas, "pointercancel", () => { this.cancel(); });
      listen(this.canvas, "pointerleave", () => { if (!this.drag) { view.cursor = this.cursorY = this.lane = this.pointer = null; hooks.cursor(view); } });
      listen(document, "keydown", event => {
        if (!this.active || event.ctrlKey || event.metaKey || event.altKey || typing(event)) return;
        const key = event.key.toLowerCase(), span = view.hi - view.lo, center = view.cursor === null ? (view.lo + view.hi) / 2 : view.cursor, big = this.element.hasAttribute("data-max");
        if (["arrowleft", "arrowright", "+", "=", "-", "a", "b", "l", "f", "e", "escape"].includes(key) || big && (key === "[" || key === "]")) event.preventDefault();
        // The next plot becomes the active one, so it must not see this key too.
        if (big && (key === "[" || key === "]")) { event.stopImmediatePropagation(); hooks.page(key === "]" ? 1 : -1); }
        if (key === "arrowleft" || key === "arrowright") this.setRange(view.lo + span * (key === "arrowleft" ? -.1 : .1), view.hi + span * (key === "arrowleft" ? -.1 : .1));
        if (["+", "=", "-"].includes(key)) this.zoom(center, key === "-" ? 1.25 : .8);
        if (key === "a" || key === "b") { if (view.live) this.live(false); view[key] = this.snap(center); }
        // Esc clears the markers or cancels a drag; with nothing to clear, it leaves the enlarged view.
        if (key === "e" || key === "escape" && !this.drag && view.a === null && view.b === null && big) hooks.enlarge(this);
        if (key === "escape") { this.cancel(); this.choose(); view.a = view.b = null; }
        if (key === "l") this.live(!view.live);
        if (key === "f") this.controls.querySelector("[data-action=Fit]").click();
        hooks.invalidate();
      });
      // A press or focus inside the plot activates it; anywhere else deactivates it, unless the plot is enlarged.
      for (const type of ["pointerdown", "focusin"]) listen(document, type, event => this.activate(this.element.contains(event.target) || this.element.hasAttribute("data-max")));
      listen(document, "pointerdown", () => this.choose());
      // A plot of lanes only is as tall as its band, the marker strip, its lanes and the time axis.
      this.observer = new ResizeObserver(() => {
        this.top = Math.max(16, this.tools.offsetHeight + 10);
        if (!this.series.length) this.area.style.height = this.top + 34 + this.lanes.length * LANE + "px";
        hooks.invalidate();
      });
      this.observer.observe(this.area); this.observer.observe(this.tools);
    }
    activate(on = true) {
      const was = this.active;
      this.element.toggleAttribute("data-active", this.active = on);
      return was;
    }
    choose(c) { this.tiles.forEach((t, i) => t.toggleAttribute("data-selected", this.sources[i] === c)); }
    save() { const g = this.view, h = g.history; h.push({lo: g.lo, hi: g.hi, live: g.live, window: g.window}); if (h.length > 20) h.shift(); }
    cancel() {
      if (this.drag) {
        const d = this.drag; Object.assign(this.view, {a: d.a, b: d.b, lo: d.lo, hi: d.hi, live: d.live});
        this.view.history.pop(); this.drag = null;
      }
      this.hooks.invalidate();
    }
    live(on) {
      // Following keeps the visible span; the view only moves to the newest data.
      const g = this.view, span = g.hi - g.lo; this.save();
      if (on && !g.live && span > 0) g.window = span;
      g.live = on; this.hooks.invalidate();
    }
    zoom(center, factor) {
      // While live, zooming only changes the followed window; the view keeps tracking incoming data.
      const g = this.view, span = g.hi - g.lo;
      if (g.live) { g.window = Math.max(.0001, (factor < 1 ? span : Math.max(span, g.window)) * factor); this.hooks.invalidate(); }
      else this.setRange(center + (g.lo - center) * factor, center + (g.hi - center) * factor);
    }
    setRange(lo, hi, remember = true) {
      const extent = this.hooks.extent(this.view), span = Math.max(.0001, hi - lo);
      if (lo < extent[0]) { lo = extent[0]; hi = lo + span; }
      if (hi > extent[1]) { hi = Math.max(extent[1], extent[0] + .001); lo = Math.max(extent[0], hi - span); }
      if (remember) this.save();
      Object.assign(this.view, {lo, hi: Math.max(hi, lo + .0001), live: false});
      this.hooks.invalidate();
    }
    track(event) {
      // Remember the pointer's position on the canvas, its y position over the numeric area, and the lane under it.
      const rect = this.canvas.getBoundingClientRect(), y = event.clientY - rect.top, bottom = this.top + this.height;
      this.cursorY = this.series.length && y <= bottom ? Math.max(this.top, y) : null;
      this.lane = this.lanes[Math.floor((y - bottom) / LANE)];
      this.pointer = event.clientX - rect.left;
      return this.view.cursor = this.at(this.pointer);
    }
    snap(t) {
      // A marker placed over a lane sticks to that lane's nearest change within 5 px.
      const p = this.lane && this.lane.history.nearest(t);
      return p && !p.summary && Math.abs(this.x(p.a[0]) - this.x(t)) <= 5 ? p.a[0] : t;
    }
    time(event) { return this.at(event.clientX - this.canvas.getBoundingClientRect().left); }
    at(x) { return this.view.lo + Math.max(0, Math.min(this.width, x - this.left)) / this.width * (this.view.hi - this.view.lo); }
    x(t) { return this.left + (t - this.view.lo) / (this.view.hi - this.view.lo) * this.width; }
    value(y) { const f = Math.max(0, Math.min(1, (y - this.top) / this.height)); return this.yMax * (1 - f) + this.yMin * f; }
    band(a, b, zoom) {
      this.selection.toggleAttribute("data-zoom", !!zoom);
      this.selection.hidden = a === null;
      if (this.selection.hidden) return;
      if (b === null) b = a;
      this.selection.hidden = Math.max(a, b) < this.view.lo || Math.min(a, b) > this.view.hi;
      if (this.selection.hidden) return;
      const x = Math.max(this.left, Math.min(this.x(a), this.x(b))), end = Math.min(this.left + this.width, Math.max(this.x(a), this.x(b)));
      this.selection.style.cssText = `left:${x}px;top:${this.top}px;width:${Math.max(0,end-x)}px;height:${this.span}px`;
    }
    inspect() {
      const g = this.view, t = g.cursor, off = t === null || t < g.lo || t > g.hi;
      this.cursor.hidden = off;
      if (!off) {
        // The time chip stays inside the plot area at its edges.
        const x = this.x(t), label = format(t) + " s"; this.pen.font = SMALL;
        const half = this.pen.measureText(label).width / 2 + 5;
        this.cursor.style.cssText = `left:${x}px;top:${this.top}px;height:${this.span}px;--shift:${Math.min(Math.max(x, half + 2), this.left + this.width + 14 - half) - x}px`;
        this.cursor.dataset.t = label;
      }
      this.horizontal.hidden = off || this.cursorY == null;
      if (!this.horizontal.hidden) { this.horizontal.style.cssText = `left:${this.left}px;top:${this.cursorY}px;width:${this.width}px`; this.horizontal.dataset.v = format(this.value(this.cursorY)); }
      this.series.forEach((c, i) => {
        const p = !off && this.place && !this.hidden.has(c) && c.history.nearest(t), ring = this.rings[i], y = p && !p.summary && p.a[5] && this.place(p.a[8]);
        ring.hidden = !(y >= this.top && y <= this.top + this.height && p.a[0] >= g.lo && p.a[0] <= g.hi);
        if (!ring.hidden) { ring.style.left = this.x(p.a[0]) + "px"; ring.style.top = y + "px"; }
      });
      this.sources.forEach((c, i) => {
        const point = c.history.nearest(t === null ? g.hi : t, t === null || !!c.lane), a = point && point.a, tile = this.tiles[i];
        if (c.lane) {
          const color = c.lane == "bus" && a && !point.summary && a[8] >= 0 ? shade(c.slots[a[8]]) : "";
          put(tile.value, !a ? "—" : point.summary ? "…" : a[8] >= 0 ? c.values[a[8]] : "—");
          if (tile.style.getPropertyValue("--value-color") !== color) tile.style.setProperty("--value-color", color);
          return;
        }
        const text = !a || !a[5] ? "—" : point.summary ? `${format(a[6])}…${format(a[7])} (mean ${format(a[8])}, n=${a[5]})` : format(a[8]);
        put(tile.value.firstChild, text);
        if (tile.unit) put(tile.unit, text === "—" ? "" : " " + c.unit);
        tile.toggleAttribute("data-summary", !!(a && point.summary));
      });
      for (const tile of this.tiles) {
        const length = tile.value.textContent.length;
        if (length > (tile.longest || 0)) { tile.style.minWidth = ""; const width = tile.getBoundingClientRect().width; if (width) { tile.longest = length; tile.style.minWidth = Math.ceil(width) + "px"; } }
      }
      // The information line: a LIVE or HOLD chip, then each value after its small label.
      let html = this.baseReadout || "Waiting for data";
      if (t !== null) {
        const s = this.series[0] || this.sources[0], point = s.history.nearest(t, !!s.lane), a = point && point.a;
        html = this.chip + pair("Elapsed", format(t) + " s") + (this.cursorY == null ? "" : pair("y", format(this.value(this.cursorY)))) + (!a ? "" : point.summary ? pair("Summary", `${format(a[0])}–${format(a[1])} s`) :
          pair("Sample", format(a[0]) + " s") + pair("Uptime", Number.isFinite(a[2]) ? "≈" + format(a[2]) + " s" : "— (unsynchronized)"));
      }
      if (this.html !== html) this.readout.innerHTML = this.html = html;
    }
    draw() {
      if (!this.host.isConnected || !this.area.clientWidth || !this.area.getClientRects().length) return;
      const w = this.area.clientWidth, h = this.area.clientHeight, dpr = Math.min(3, window.devicePixelRatio || 1), g = this.view;
      // Lanes sit between the numeric area and the x axis. A plot of lanes only keeps a 14 px strip for marker labels.
      const T = this.top, B = h - 20, now = this.hooks.now();
      this.height = this.series.length ? Math.max(1, B - T - this.lanes.length * LANE) : 14; this.span = B - T;
      const Y = T + this.height;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) { this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr); }
      const ctx = this.canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      let low = Infinity, high = -Infinity, retained = 0;
      for (const c of this.sources) {
        if (this.hidden.has(c)) continue;
        const a = c.history.range(g.lo, g.hi);
        if (a && a[5]) { if (!c.lane) { low = Math.min(low, a[6]); high = Math.max(high, a[7]); } retained += a[5]; }
      }
      if (!Number.isFinite(low)) { low = 0; high = 1; }
      const magnitude = Math.max(Math.abs(low), Math.abs(high)) || 1;
      const pad = Math.max(Number.MIN_VALUE, ((high / magnitude - low / magnitude) || 1) * .06 * magnitude);
      this.yMin = this.y ? this.y[0] : this.min === null ? Math.max(-Number.MAX_VALUE, low - pad) : this.min;
      this.yMax = this.y ? this.y[1] : this.max === null ? Math.min(Number.MAX_VALUE, high + pad) : this.max;
      if (this.yMin >= this.yMax) { this.yMax = Math.min(Number.MAX_VALUE, this.yMin + pad); this.yMin = Math.max(-Number.MAX_VALUE, this.yMin - pad); }
      const scale = Math.max(Math.abs(this.yMin), Math.abs(this.yMax), Number.MIN_VALUE);
      const y = this.place = v => T + (this.yMax / scale - v / scale) / (this.yMax / scale - this.yMin / scale) * this.height;
      const ink = getComputedStyle(this.area).color;
      ctx.font = SMALL; ctx.fillStyle = ctx.strokeStyle = ink; ctx.lineWidth = 1;
      const rule = (x0, y0, x1, y1, faint) => { ctx.globalAlpha = faint ? .3 : 1; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.globalAlpha = 1; };
      const L = this.left = Math.max(this.need, g.gutter || 0), end = w - 16;
      this.width = Math.max(1, w - L - 16);
      const band = L + 2 + "px"; if (this.tools.style.left !== band) this.tools.style.left = band;
      // Y labels read across, as on a camera's scales; the gutter grows to the longest one on the next frame.
      ctx.textAlign = "right";
      const yTicks = this.series.length ? ticks(this.yMin, this.yMax, Math.max(2, Math.min(6, this.height / 30))).map(v => [Math.round(y(v)) + .5, format(v)]) : [];
      // The gutter only grows, so changing labels never shift the plot sideways.
      this.need = Math.max(this.need, ...yTicks.map(t => Math.ceil(ctx.measureText(t[1]).width / 4) * 4 + 12));
      for (const [p, label] of yTicks) { rule(L, p, end, p, true); rule(L - 4, p, L, p); centered(ctx, label, L - 6, Math.min(Y - 5, Math.max(T + 5, p))); }
      ctx.textAlign = "center";
      const title = "Elapsed time (s)", room = end - ctx.measureText(title).width - 8;
      for (const v of ticks(g.lo, g.hi, Math.max(2, this.width / 90))) {
        const p = Math.round(this.x(v)) + .5, label = format(v); rule(p, T, p, B, true); rule(p, B, p, B + 4);
        if (p + ctx.measureText(label).width / 2 < room) ctx.fillText(label, p, h - 5);
      }
      rule(L + .5, T, L + .5, B + .5); rule(L, B + .5, end, B + .5);
      ctx.textAlign = "right"; ctx.fillText(title, end, h - 5); ctx.textAlign = "left"; ctx.fillText(this.unit, 4, T - 4);
      ctx.save(); ctx.beginPath(); ctx.rect(L, T, this.width, this.height); ctx.clip();
      for (const c of this.series) {
        if (this.hidden.has(c)) continue;
        const color = tint(c); ctx.strokeStyle = ctx.fillStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
        let connected = false;
        c.history.query(g.lo, g.hi, Math.min(2048, this.width), (a, summary) => {
          if (!a[5]) { connected = false; return; }
          if (summary || a[14]) {
            ctx.stroke(); ctx.globalAlpha = .25;
            ctx.fillRect(this.x(a[0]), y(a[7]), Math.max(1, this.x(a[1]) - this.x(a[0])), Math.max(1, y(a[6]) - y(a[7])));
            ctx.globalAlpha = 1; ctx.beginPath(); ctx.moveTo(this.x(a[0]), y(a[6])); ctx.lineTo(this.x(a[1]), y(a[6]));
            ctx.moveTo(this.x(a[0]), y(a[7])); ctx.lineTo(this.x(a[1]), y(a[7])); ctx.stroke(); ctx.beginPath(); connected = false;
          } else {
            const line = (t, v) => { if (connected) ctx.lineTo(this.x(t), y(v)); else ctx.moveTo(this.x(t), y(v)); connected = true; };
            line(a[0], a[10]);
            if (a[12] <= a[13]) { line(a[12], a[6]); line(a[13], a[7]); }
            else { line(a[13], a[7]); line(a[12], a[6]); }
            line(a[1], a[11]);
            if (a[15] === 1 && retained < 100) { ctx.fillRect(this.x(a[0]) - 1.5, y(a[8]) - 1.5, 3, 3); }
          }
        });
        ctx.stroke();
      }
      ctx.restore();
      // Lanes: bus lanes draw labelled segments with slanted ends at each change; logic lanes draw a high/low line.
      // Changes too close together to draw show as a gray block with their count.
      ctx.save(); ctx.lineWidth = 1;
      this.lanes.forEach((c, i) => {
        const top = Y + i * LANE + 2, mid = top + 8, bottom = top + 16, color = tint(c);
        ctx.font = SMALL; ctx.textAlign = "right"; ctx.fillStyle = ctx.strokeStyle = ink;
        centered(ctx, clip(ctx, c.label, L - 10), L - 6, mid); rule(L, top - 1.5, end, top - 1.5, true);
        if (this.hidden.has(c)) return;
        ctx.save(); ctx.beginPath(); ctx.rect(L + 1, top - 1, this.width, LANE - 2); ctx.clip();
        ctx.font = LARGE; ctx.textAlign = "center";
        let start = null, value = -1;
        const close = t => {
          const x0 = Math.max(L - 4, this.x(start)), x1 = Math.min(end + 4, this.x(t)), text = c.values[value];
          if (start === null || value < 0 || x1 - x0 < 1) return;
          if (c.lane == "logic") {
            const on = text == "1", level = on ? top + .5 : bottom - .5;
            ctx.strokeStyle = ctx.fillStyle = color;
            if (on) { ctx.globalAlpha = .25; ctx.fillRect(x0, top, x1 - x0, 16); ctx.globalAlpha = 1; }
            ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(x0, bottom); ctx.moveTo(x0, level); ctx.lineTo(x1, level); ctx.stroke();
            return;
          }
          const slant = Math.min(3, (x1 - x0) / 2), a = Math.max(x0, L), b = Math.min(x1, end), label = clip(ctx, text, b - a - 8);
          ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x0 + slant, top); ctx.lineTo(x1 - slant, top); ctx.lineTo(x1, mid); ctx.lineTo(x1 - slant, bottom); ctx.lineTo(x0 + slant, bottom); ctx.closePath();
          ctx.fillStyle = shade(c.slots[value], 1); ctx.fill(); ctx.strokeStyle = shade(c.slots[value]); ctx.stroke();
          if (label) { ctx.fillStyle = "#fff"; centered(ctx, label, (a + b) / 2, mid); }
        };
        const busy = (t0, t1, n, summary) => {
          const x0 = this.x(t0), x1 = Math.max(x0 + 2, this.x(t1)), label = clip(ctx, n + " changes" + (summary ? ", summarized" : ""), x1 - x0 - 8);
          ctx.fillStyle = "#383838"; ctx.strokeStyle = "#969696"; ctx.fillRect(x0, top, x1 - x0, 16); ctx.strokeRect(x0 + .5, top + .5, x1 - x0 - 1, 15);
          if (label) { ctx.fillStyle = "#fff"; centered(ctx, label, (x0 + x1) / 2, mid); }
        };
        // The value in effect at the left edge comes from the last change before it.
        const p = c.history.nearest(g.lo, true);
        if (p && p.a[0] < g.lo && !(p.summary && p.a[1] >= g.lo)) { start = p.summary ? p.a[1] : p.a[0]; value = p.a[p.summary ? 11 : 8]; }
        c.history.query(g.lo, g.hi, Math.min(2048, this.width), (a, summary) => {
          close(a[0]);
          if (a[15] === 1 && !summary) { start = a[0]; value = a[10]; }
          else { busy(a[0], a[1], a[15], summary); start = a[1]; value = a[11]; }
        });
        close(Math.min(g.hi, now));
        ctx.restore();
      });
      ctx.restore();
      const d = this.drag, z = d && this.mode == "Zoom";
      ctx.save(); ctx.beginPath(); ctx.rect(L, T, this.width, this.span); ctx.clip();
      ctx.strokeStyle = ctx.fillStyle = "#ff3b30"; ctx.setLineDash([4, 3]);
      for (const marker of this.hooks.restarts()) if (marker.time >= g.lo && marker.time <= g.hi) {
        const x = this.x(marker.time); ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke(); ctx.fillText("≈ restart", x + 4, T + 12);
      }
      // Each marker carries an orange flag with its letter at the top of its line, on the outer side of the interval,
      // so the line never crosses the letter. A flag with no room there turns inward.
      ctx.setLineDash([]); ctx.font = SMALL; ctx.textAlign = "center";
      if (!z) for (const [name, t, other] of [["A", g.a, g.b], ["B", g.b, g.a]]) if (t !== null) {
        const x = Math.round(this.x(t)), out = (other === null ? name == "B" : t > other) ? 1 : -1, side = x + out * 15 < L || x + out * 15 > end ? -out : out;
        ctx.fillStyle = "#ff7a00"; ctx.fillRect(side < 0 ? x - 14 : x + 1, T, 14, 14);
        ctx.fillStyle = "#000"; centered(ctx, name, x + side * 7.5 + .5, T + 7);
      }
      ctx.restore();
      if (!retained && !this.lanes.some(c => c.last >= 0)) { ctx.textAlign = "center"; ctx.fillStyle = ink; ctx.fillText("Waiting for valid data", L + this.width / 2, h / 2); }
      // The header lamp shows the live state while the controls are hidden.
      this.liveBox.checked = g.live; this.element.toggleAttribute("data-live", g.live);
      this.chip = `<span class="turbo-sse-chip"${g.live ? "" : " data-hold"}>${g.live ? "Live" : "Hold"}</span>`;
      this.baseReadout = this.chip + pair("Window", `${format(g.lo)}–${format(g.hi)} s`) + ` <span><b>${retained}</b> samples</span>` +
        (this.sources.some(c => c.history.compacted) ? " <span>Older history summarized</span>" : "") +
        (this.sources.some(c => c.history.evicted) ? " <span>Oldest coverage expired</span>" : "");
      this.band(z ? d.t : g.a, z ? d.end : g.b, z);
      this.inspect();
      // Measurements are an A/B line and tables with one row per series. The row count never changes,
      // so measuring never shifts the page.
      const both = g.a !== null && g.b !== null, lo = Math.min(g.a, g.b), hi = Math.max(g.a, g.b), dt = hi - lo;
      // The A/B line sets each value after its small label, as a camera's shooting screen does.
      const mark = (label, v, unit) => `<span><small>${label}</small> <b>${format(v)}${Number.isFinite(v) ? " " + unit : ""}</b></span>`;
      const first = mark("A", g.a ?? NaN, "s") + " " + mark("B", g.b ?? NaN, "s") + (both ? " " + mark("Δt", dt, "s") + " " + mark("1/Δt", dt ? 1 / dt : NaN, "Hz") : "");
      const rows = this.series.map(c => {
        const a = both && c.history.range(lo, hi), row = [c.label + (c.unit ? " (" + c.unit + ")" : ""), both ? 0 : "—", "—", "—", "—", "—", "—", "—", "—", "—"];
        if (!a || !a[5]) return row;
        const sd = a[9], left = c.history.nearest(lo), right = c.history.nearest(hi);
        row.splice(1, 7, a[5], format(a[6]), format(a[7]), format(a[7] - a[6]), format(a[8]), format(Math.hypot(a[8], sd)), format(sd));
        if (left && right && left.a[5] && right.a[5]) {
          const dy = right.a[8] - left.a[8], seconds = right.a[0] - left.a[0], summary = left.summary || right.summary;
          row[8] = format(dy) + (summary ? " (means)" : "");
          if (!summary) row[9] = format(seconds ? dy / seconds : NaN);
        }
        if (a[0] < lo || a[1] > hi) row[0] += ` · summary ${format(a[0])}–${format(a[1])} s`;
        return row;
      });
      // Lanes: the values held at A and B, the changes between them, the distinct values, and the value held longest.
      // Summarized history makes the counts lower bounds.
      const at = (c, t) => { const p = c.history.nearest(t, true); return !p ? "—" : p.summary ? "…" : p.a[8] >= 0 ? c.values[p.a[8]] : "—"; };
      const lanes = this.lanes.map(c => {
        if (!both) return [c.label, "—", "—", "—", "—", "—"];
        const time = new Map(), p = c.history.nearest(lo, true);
        let from = lo, value = p && !p.summary ? p.a[8] : -1, changes = 0, more = "", best = -1, longest = 0;
        const hold = t => { if (value >= 0 && t > from) time.set(value, (time.get(value) || 0) + t - from); from = Math.max(from, t); };
        for (const {a, summary} of c.history.rows(lo, hi)) {
          hold(a[0]);
          if (summary) { more = "≥"; changes += a[15]; from = Math.max(from, a[1]); value = a[11]; }
          else { changes += a[0] > lo; value = a[8]; }
        }
        hold(Math.min(hi, now));
        for (const [v, held] of time) if (held > longest) { best = v; longest = held; }
        return [c.label, at(c, g.a), at(c, g.b), more + changes, more + time.size, best < 0 ? "—" : `${c.values[best]} ${format(longest)} s (${Math.round(100 * longest / (dt || 1))}%)`];
      });
      const tables = [];
      if (this.series.length) tables.push([["Series", "n", "min", "max", "p-p", "mean", "RMS", "σ", "Δy", "slope /s"], rows, this.series]);
      if (this.lanes.length) tables.push([["Lane", "At A", "At B", "Changes", "Distinct", "Longest"], lanes, this.lanes]);
      const text = JSON.stringify([first, tables.map(t => t.slice(0, 2))]);
      this.measure.toggleAttribute("data-idle", g.a === null && g.b === null);
      if (text !== this.rows) {
        this.rows = text;
        const line = make("p", ""); line.innerHTML = first;
        this.result.replaceChildren(line, ...tables.map(([names, cells, sources]) => {
          const table = make("table", ""), head = make("tr", "", undefined, make("thead", "", undefined, table)), body = make("tbody", "", undefined, table);
          for (const name of names) make("th", "", name, head);
          cells.forEach(([name, ...row], i) => {
            const tr = make("tr", "", undefined, body), th = make("th", "", name, tr);
            th.dataset.n = sources[i].id; th.style.setProperty("--series-color", tint(sources[i]));
            for (const cell of row) make("td", "", String(cell), tr);
          });
          return table;
        }));
      }
    }
    destroy() { this.abort.abort(); this.observer.disconnect(); this.element.remove(); this.host.style.minHeight = ""; }
  }

  function start(root) {
    const counts = {received: 0, evicted: 0, oversized: 0, parseErrors: 0, transformErrors: 0, configErrors: 0, appendDrops: 0, omitted: 0, clockErrors: 0, restarts: 0, graphErrors: 0, markerEvictions: 0};
    let capture;
    let timeout = 0;
    let source = null;
    let dead = false;
    let state = "Connecting";
    let lastId = "";
    let lastReceive = 0;
    let watchdog = 0;
    let retryTimer = 0;
    let frame = 0;
    let bindings = new Map();
    let elements = new Map();
    const events = new Set(["message", "heartbeat"]);
    const dirty = new Set();
    const started = performance.now();
    const omitted = new Set((attr(root, "omit-raw") || "").split(/\s+/).filter(Boolean));
    const uptimeEvent = attr(root, "uptime-event") || "uptime";
    const clock = {value: null, at: 0, synced: false, opened: false, compare: false, segment: 0};
    const restarts = [];
    let graphBudget = 33554432, clockBudget = 32768, serial = 0;
    let channels = new Map(), plots = new Map(), groups = new Map();
    let graphDirty = false, lastDraw = -Infinity, big = null, saved = 0, pulse = -Infinity;
    const off = new AbortController(), on = (name, fn) => addEventListener(name, fn, {signal: off.signal});
    // The topbar: the connection state as a lit tab, readouts as small labels before values, then the keys.
    // The jump menu drops from it: one page of a camera menu, with the query in its title row.
    const bar = document.createElement("div");
    bar.className = "turbo-sse-bar";
    bar.innerHTML = '<span class="turbo-sse-status" role="status" aria-live="polite"></span><button type="button" class="turbo-sse-retry" hidden><span>Retry</span></button><span class="turbo-sse-uptime"></span><span class="turbo-sse-counts"></span><output></output>' +
      '<button type="button" class="turbo-sse-jump" aria-haspopup="dialog" aria-expanded="false" hidden><span>Jump</span><kbd>J</kbd></button><button type="button" class="turbo-sse-export"><span>Export All</span></button>' +
      '<div class="turbo-sse-menu" role="dialog" aria-label="Jump to a plot" hidden><label><span>Jump to</span><input role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="turbo-sse-results" autocomplete="off" spellcheck="false" placeholder="Plot or series name"><output aria-hidden="true"></output></label>' +
      '<ul id="turbo-sse-results" role="listbox"></ul><p><span></span><span><kbd class="turbo-sse-sign">↑</kbd><kbd class="turbo-sse-sign">↓</kbd> Select</span><span><kbd>Enter</kbd> Jump</span><span><kbd>Esc</kbd> Close</span><span role="status"></span></p></div>';
    const [status, retryButton, uptimeDisplay, counter, note, jumpButton, exportButton, menu] = bar.children;
    const [query, pageCount] = menu.querySelectorAll("input, output"), list = menu.querySelector("ul"), [pages, , , , found] = menu.querySelector("p").children;
    root.prepend(bar);

    function configError(error) {
      counts.configErrors++;
      console.warn("TurboSSE:", error.message);
    }

    function setState(value) {
      if (state === "Connected" && value !== "Connected") {
        for (const c of channels.values()) graphPoint(c, (performance.now() - started) / 1000, NaN, NaN);
        invalidate();
      }
      state = value;
      if (value !== "Connected") clock.synced = false;
      bar.dataset.state = value.toLowerCase();
      status.textContent = value;
      retryButton.hidden = value !== "Disconnected";
    }

    function uptime(time) {
      return clock.synced ? clock.value + (time - clock.at) / 1000 : NaN;
    }

    function shareBudget(owner) {
      const histories = Array.from(channels.values(), c => c.history);
      let spare = graphBudget - clockBudget - histories.reduce((n, h) => n + h.bytes, 0);
      while (owner ? owner.bytes + spare < 4096 : spare < 0) {
        const donor = histories.filter(h => h !== owner && h.bytes > 4096).sort((a, b) => b.bytes - a.bytes)[0];
        if (!donor) throw new Error("Graph budget too small");
        const before = donor.bytes;
        donor.resize(Math.max(4096, before - (owner ? 4096 - owner.bytes - spare : -spare)));
        spare += before - donor.bytes;
      }
      if (owner) owner.limit = owner.bytes + spare;
    }

    function graphPoint(c, t, u, value) {
      const h = c.history;
      if (c.lane) { if (!(value >= 0)) value = -1; if (value === c.last) return; c.last = value; }
      // Reserve only when a chunk/segment is about to grow. A busy channel can
      // use idle channels' space instead of prematurely reducing its history.
      if (!h.current || h.current.a[15] === BLOCK || h.current.a[4] !== clock.segment) shareBudget(h);
      h.add(t, u, value, clock.segment);
    }

    function stats() {
      const u = uptime(performance.now());
      return Object.assign({}, counts, {state, retained: capture ? capture.size : 0, bytes: capture ? capture.bytes : 0, lastEventId: lastId,
        uptime: Number.isFinite(u) ? u : null, lastUptime: clock.value, segment: clock.segment,
        graphs: {bytes: Array.from(channels.values()).reduce((n, c) => n + c.history.bytes, restarts.length * 128),
          plots: plots.size, series: Array.from(channels.values(), c => {
            const a = c.history.range();
            return {id: c.id, label: c.label, event: c.event, raw: c.history.raw, compacted: c.history.compacted,
              evicted: c.history.evicted, bytes: c.history.bytes, samples: a ? a[5] : 0, gaps: a ? a[14] : 0,
              from: a ? a[0] : null, to: a ? a[1] : null};
          })}});
    }

    // Counters show only when they have something to say; losses and errors are yellow.
    function counters() {
      const s = stats(), show = (node, html) => { if (node.html !== html) node.innerHTML = node.html = html; };
      let html = "";
      for (const [key, label] of [["retained", "Captured"], ["evicted", "Evicted"], ["omitted", "Omitted"], ["oversized", "Oversized"], ["appendDrops", "Append drops"], ["parseErrors", "JSON errors"], ["transformErrors", "Transform errors"], ["configErrors", "Config errors"], ["clockErrors", "Clock errors"], ["graphErrors", "Graph errors"], ["markerEvictions", "Expired markers"]]) {
        if (s[key] || key == "retained" || key == "evicted") html += `<span${s[key] && !/^(retained|omitted)$/.test(key) ? " data-warn" : ""}><small>${label}</small> <b>${String(s[key]).replace(/\B(?=(\d{3})+$)/g, "\u202f")}</b></span> `;
      }
      show(counter, html);
      show(uptimeDisplay, "<small>Uptime</small> <b>" + (s.uptime === null ? "—" + (clock.value === null ? "" : " (unsynchronized)") :
        "≈" + [Math.floor(s.uptime / 3600), Math.floor(s.uptime / 60) % 60, Math.floor(s.uptime) % 60].map(v => String(v).padStart(2, "0")).join(":")) + "</b>");
      exportButton.toggleAttribute("data-unsaved", counts.received > saved);
      if (Array.from(groups.values()).some(g => g.live)) invalidate();
    }

    // One plot at a time can be enlarged to fill the window below the topbar. A history entry holds it, so the
    // browser's Back button returns to the page and Forward enlarges the plot again.
    function enlarge(plot) {
      if (plot && plot === big) return history.back();
      const all = Array.from(plots.values());
      if (plot) history.pushState({turboSSE: all.indexOf(plot) + 1}, "");
      big = all[(history.state || 0).turboSSE - 1] || null;
      for (const p of all) {
        const max = p === big, e = p.element;
        if (big) p.activate(max);  // The enlarged plot is the active one.
        if (max !== e.hasAttribute("data-max")) {
          // The plot leaves the page flow; its place keeps its height, and the page its scroll position.
          p.host.style.minHeight = max ? p.host.getBoundingClientRect().height + "px" : "";
          e.toggleAttribute("data-max", max);
        }
        e.style.top = max ? Math.max(0, bar.getBoundingClientRect().bottom) + "px" : "";
        put(p.full.firstChild, max ? "Reduce" : "Enlarge");
        // The title bar counts the plots, ‹ 2/4 ›, and the guide shows a square for each, the current one orange.
        put(p.page, all.indexOf(p) + 1 + "/" + all.length);
        if (max) p.squares.innerHTML = all.map(q => q === p ? "<i data-on></i>" : "<i></i>").join("");
      }
      invalidate();
    }

    // Steps the enlarged view to a neighbouring plot. The enlarged view keeps its one history entry.
    function page(step) {
      const all = Array.from(plots.values()), shown = all.filter(p => p === big || p.host.getClientRects().length);
      if (!big || shown.length < 2) return;
      show(shown[(shown.indexOf(big) + step + shown.length) % shown.length]);
    }

    // Brings a plot into use: enlarged in place of the enlarged one, or scrolled to just below the topbar.
    function show(plot, series) {
      if (big) { if (plot !== big) { history.replaceState({turboSSE: Array.from(plots.values()).indexOf(plot) + 1}, ""); enlarge(); } }
      else scrollTo(scrollX, scrollY + plot.element.getBoundingClientRect().top - bar.getBoundingClientRect().bottom - 8);
      plot.canvas.focus({preventScroll: true});
      plot.choose(series);
    }

    // Jump to a plot: type part of a plot title or series name. Exact and leading matches rank first, then word
    // starts, initials and matches anywhere; units and event names count from three letters on. An empty query
    // lists every plot with its series. Six rows make a page, as in a camera menu.
    let results = [], chosen = 0, opener = null;
    function rank(name, extra, q) {
      const n = name.toLowerCase(), i = n.indexOf(q), words = n.split(/[\s/_-]+/);
      return !q ? 1 : n === q ? 6 : !i ? 5 : i > 0 && /[\s/_-]/.test(n[i - 1]) ? 4 : words.map(w => w[0]).join("").startsWith(q) ? 3 : i > 0 ? 2 : q.length > 2 && extra.toLowerCase().split(/\s+/).some(w => w && w.startsWith(q)) ? 1 : 0;
    }
    function search() {
      const q = query.value.trim().toLowerCase(), all = [];
      for (const p of plots.values()) {
        all.push({p, name: p.title, extra: p.units});
        for (const c of p.sources) all.push({p, c, name: c.label, extra: c.unit + " " + c.event});
      }
      results = all.map((x, k) => Object.assign(x, {k, r: rank(x.name, x.extra, q)})).filter(x => x.r);
      if (q) results.sort((a, b) => b.r - a.r || !!a.c - !!b.c || a.k - b.k);
      chosen = Math.max(0, Math.min(chosen, results.length - 1));
      const count = Math.max(1, Math.ceil(results.length / 6)), at = chosen / 6 | 0;
      pageCount.textContent = `‹${at + 1}/${count}›`;
      pages.innerHTML = Array.from({length: count}, (_, i) => i === at ? "<i data-on></i>" : "<i></i>").join("");
      found.textContent = results.length + (results.length === 1 ? " match" : " matches");
      list.replaceChildren(...(results.length ? results.slice(at * 6, at * 6 + 6) : [null]).map((x, k) => {
        const li = make("li", "");
        li.setAttribute("role", "option");
        if (!x) { li.textContent = "No plot or series matches “" + query.value + "”"; li.setAttribute("aria-disabled", "true"); return li; }
        const index = at * 6 + k, start = q ? x.name.toLowerCase().indexOf(q) : -1, name = make("b", "", start < 0 ? x.name : x.name.slice(0, start), li), c = x.c;
        if (start >= 0) { make("mark", "", x.name.slice(start, start + q.length), name); name.append(x.name.slice(start + q.length)); }
        li.id = "turbo-sse-result-" + index; li.dataset.i = index;
        li.setAttribute("aria-selected", index === chosen);
        if (c) {
          li.dataset.n = c.id; li.style.setProperty("--series-color", tint(c));
          make("small", "", x.p.title, li);
          const v = make("b", "", c.lane || c.text === undefined ? c.text || "—" : format(numeric(c.text)), li);
          if (c.unit && !c.lane && c.text && c.text !== "—") make("small", "", " " + c.unit, v);
        } else { li.dataset.plot = ""; make("small", "", x.p.sources.length + " series" + (x.p.units ? " · " + x.p.units : ""), li); }
        return li;
      }));
      query.setAttribute("aria-activedescendant", results.length ? "turbo-sse-result-" + chosen : "");
    }
    function jump(open) {
      if (open === !menu.hidden) return;
      menu.hidden = !open; jumpButton.setAttribute("aria-expanded", open);
      if (open) { opener = document.activeElement; query.value = ""; chosen = 0; search(); query.focus(); }
      else if (menu.contains(document.activeElement) && opener) opener.focus();
    }
    function go(i) {
      const x = results[i];
      if (!x) return;
      opener = null; jump(false); show(x.p, x.c);
    }
    query.addEventListener("input", () => { chosen = 0; search(); });
    query.addEventListener("keydown", event => {
      const key = event.key, n = results.length;
      event.stopPropagation();  // Typing here never reaches the plots' shortcuts.
      if (key === "ArrowDown" || key === "ArrowUp") { if (n) chosen = (chosen + (key === "ArrowDown" ? 1 : n - 1)) % n; }
      else if (key === "PageDown" || key === "PageUp") { if (n) chosen = Math.max(0, Math.min(n - 1, chosen + (key === "PageDown" ? 6 : -6))); }
      else if (key === "Enter") go(chosen);
      else if (key === "Escape") jump(false);
      else return;
      event.preventDefault();
      if (!menu.hidden) search();
    });
    list.addEventListener("pointerdown", event => event.preventDefault());
    list.addEventListener("pointermove", event => { const li = event.target.closest("[data-i]"); if (li && +li.dataset.i !== chosen) { chosen = +li.dataset.i; search(); } });
    list.addEventListener("click", event => { const li = event.target.closest("[data-i]"); if (li) go(+li.dataset.i); });
    pageCount.addEventListener("click", () => { chosen = (chosen / 6 | 0) * 6 + 6; if (chosen >= results.length) chosen = 0; search(); query.focus(); });

    function fragment(element, text, html) {
      if (!html) return document.createTextNode(text);
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.createContextualFragment(text);
    }

    function invalidate() {
      if (dead || !plots.size) return;
      graphDirty = true;
      if (!frame) frame = requestAnimationFrame(flush);
    }

    function extent(view) {
      let lo = Infinity, hi = -Infinity;
      for (const p of plots.values()) if (!view || p.view === view) for (const c of p.sources) {
        const a = c.history.range();
        if (a) { lo = Math.min(lo, a[0]); hi = Math.max(hi, c.last >= 0 ? (performance.now() - started) / 1000 : a[1]); }
      }
      return Number.isFinite(lo) ? [lo, hi] : [0, 1];
    }

    function flush() {
      frame = 0;
      for (const b of dirty) {
        if (!root.contains(b.element)) continue;
        if (b.append) {
          for (const node of b.removed) node.remove();
          b.removed = [];
          const batch = document.createDocumentFragment();
          b.entries.each(entry => {
            if (entry.nodes) return;
            const content = fragment(b.element, entry.text, b.html);
            entry.nodes = content.nodeType === 11 ? Array.from(content.childNodes) : [content];
            batch.append(content);
          });
          b.element.append(batch);
        } else if (b.pending !== undefined) {
          if (b.html) b.element.replaceChildren(fragment(b.element, b.pending, true));
          else if (b.previous !== b.pending) b.element.textContent = b.pending;
          b.previous = b.pending;
          b.pending = undefined;
        }
      }
      dirty.clear();
      if (graphDirty) {
        if (performance.now() - lastDraw < 33) { frame = requestAnimationFrame(flush); return; }
        graphDirty = false;
        lastDraw = performance.now();
        for (const g of groups.values()) {
          const r = extent(g);
          if (g.live) { const end = Math.max(r[1], (performance.now() - started) / 1000); g.lo = Math.max(r[0], end - g.window); g.hi = Math.max(g.lo + .001, end); }
          else if (g.hi < r[0]) { const span = g.hi - g.lo; g.lo = r[0]; g.hi = Math.max(g.lo + .001, Math.min(r[1], g.lo + span)); g.cursor = null; }
        }
        for (const g of groups.values()) g.gutter = 0;
        for (const p of plots.values()) p.view.gutter = Math.max(p.view.gutter, p.need);
        // A resting pointer keeps its crosshair under it while the view follows new data, pans or zooms.
        for (const p of plots.values()) if (p.pointer != null) { p.left = p.view.gutter; p.width = Math.max(1, p.area.clientWidth - p.left - 16); p.view.cursor = p.at(p.pointer); }
        for (const p of plots.values()) {
          if (p.failed || big && p !== big) continue;  // Plots behind an enlarged one rest.
          try { p.draw(); }
          catch (error) { counts.graphErrors++; p.failed = true; p.readout.textContent = "Graph error: " + error.message; }
        }
        for (const p of plots.values()) if (p.need > p.view.gutter) invalidate();
      }
    }

    function receive(event) {
      if (dead) return;
      const elapsed = performance.now();
      lastReceive = elapsed;
      if (elapsed - pulse > 100) { pulse = elapsed; status.toggleAttribute("data-pulse", true); setTimeout(() => status.removeAttribute("data-pulse"), 60); }
      lastId = event.lastEventId;
      counts.received++;
      const record = {time: Date.now(), elapsed: elapsed - started, event: event.type, id: lastId, data: event.data,
        bytes: 2 * (event.type.length + lastId.length + event.data.length)};
      if (omitted.has(event.type)) counts.omitted++;
      else if (!capture.push(record, () => counts.evicted++)) counts.oversized++;
      if (event.type === uptimeEvent) {
        // The device reports its uptime as an unsigned integer of microseconds; estimates are kept in seconds.
        const text = event.data.trim(), value = /^\d+$/.test(text) ? Number(text) / 1e6 : NaN;
        if (!Number.isFinite(value)) counts.clockErrors++;
        else {
          if (clock.compare && clock.value !== null && value < clock.value) {
            clock.segment++;
            counts.restarts++;
            restarts.push({time: record.elapsed / 1000 - value, detected: record.elapsed / 1000, segment: clock.segment});
            if (restarts.length > clockBudget / 128) { restarts.shift(); counts.markerEvictions++; }
            invalidate();
          }
          clock.value = value; clock.at = elapsed; clock.synced = true; clock.compare = false;
        }
      }
      const targets = bindings.get(event.type);
      if (!targets) return;
      let parsed, attempted = false, invalid = false;
      const keep = (c, value) => {
        if (c.tick === counts.received) return c.text;
        c.tick = counts.received;
        if (value === undefined) { c.text = undefined; return; }
        let y;
        if (c.lane) {
          // A lane's value is its text, at most 64 characters; logic lanes reduce it to 1 or 0. Missing, empty
          // and unrecognized values leave a gap, as does a new value beyond the 1024 distinct values a lane keeps.
          let text = value === null ? "" : normalize(value).slice(0, 64);
          if (text && c.lane == "logic") {
            const n = numeric(text);
            text = n === n ? (n ? "1" : "0") : /^(true|on|high)$/i.test(text) ? "1" : /^(false|off|low)$/i.test(text) ? "0" : (counts.graphErrors++, "");
          }
          y = text ? c.index.get(text) : -1;
          if (y === undefined) {
            if (c.values.length < 1024) {
              const [first, second] = choices(text), hue = slot => c.slots.some(s => s % 8 == slot % 8);
              c.slots.push(hue(first) && !hue(second) || c.slots.includes(first) && !c.slots.includes(second) ? second : first);
              c.index.set(text, y = c.values.push(text) - 1);
            }
            else { counts.graphErrors++; y = -1; }
          }
          c.text = text || "—";
        } else {
          y = value === null ? NaN : numeric(value);
          if (value !== null && !Number.isFinite(y)) counts.graphErrors++;
          c.text = Number.isFinite(y) ? String(y) : "—";
        }
        graphPoint(c, record.elapsed / 1000, uptime(elapsed), y);
        invalidate();
        return c.text;
      };
      for (const b of targets) {
        if (!root.contains(b.element)) continue;
        const c = b.series;
        let value = event.data;
        if (c && c.tick === counts.received) value = c.text;
        else {
          if (b.path !== null) {
            if (!attempted) {
              attempted = true;
              try { parsed = JSON.parse(event.data); }
              catch (_) { invalid = true; counts.parseErrors++; }
            }
            if (invalid) { if (c) keep(c, null); continue; }
            value = select(parsed, b.path);
            if (value === undefined) { if (c) keep(c, null); continue; }
          }
          try {
            if (b.transform) value = b.transform(value);
            if (c) {
              if (value && typeof value.then === "function") { Promise.resolve(value).catch(() => {}); throw new Error("Asynchronous transform"); }
              value = keep(c, value);
            } else value = normalize(value);
          } catch (_) { counts.transformErrors++; if (c) keep(c, null); continue; }
        }
        if (value === undefined || b.directGraph) continue;
        if (b.append) {
          const accepted = b.entries.push({text: value, bytes: value.length * 2}, old => {
            counts.appendDrops++;
            if (old.nodes) b.removed.push(...old.nodes);
          });
          if (!accepted) { counts.appendDrops++; continue; }
        } else b.pending = value;
        dirty.add(b);
      }
      if (dirty.size && !frame) frame = requestAnimationFrame(flush);
    }

    function register(name) {
      if (!name || /\s/.test(name) || name === "open" || name === "error") throw new Error("Invalid SSE event name: " + name);
      if (!events.has(name)) {
        events.add(name);
        if (source) source.addEventListener(name, receive);
      }
    }

    function refresh() {
      if (frame) cancelAnimationFrame(frame);
      flush();
      for (const b of elements.values()) if (b.series && !b.directGraph) b.element.hidden = b.wasHidden;
      const next = new Map(), nextChannels = new Map(), hosts = new Map(), nextPlots = new Map(), nextGroups = new Map();
      bindings = new Map();
      for (const name of (attr(root, "events") || "").split(/\s+/).filter(Boolean)) {
        try { register(name); } catch (error) { configError(error); }
      }
      const nodes = Array.from(root.querySelectorAll("[data-sse-event]"));
      if (root.hasAttribute("data-sse-event")) nodes.unshift(root);
      for (const element of nodes) {
        try {
          if (element === root) throw new Error("Connection root cannot also be a binding");
          const parentBinding = element.parentElement.closest("[data-sse-event]");
          if (parentBinding && root.contains(parentBinding)) throw new Error("Nested SSE bindings are not supported");
          const name = attr(element, "event"); register(name);
          const swap = attr(element, "swap") || "replace", format = attr(element, "format") || "text";
          if (!["replace", "append"].includes(swap) || !["text", "html"].includes(format)) throw new Error("Invalid swap or format");
          const path = pointer(attr(element, "json")), fn = attr(element, "transform");
          let transform = null;
          if (fn !== null) {
            if (!/^[A-Za-z_$][\w$]*$/.test(fn) || !own(window, fn) || typeof window[fn] !== "function") throw new Error("Unknown transform: " + fn);
            transform = window[fn];
          }
          const limit = number(element, "limit", 500, 1);
          const signature = JSON.stringify([name, swap, format, path, fn, limit]);
          let b = elements.get(element);
          if (!b || b.signature !== signature) {
            b = {element, signature, append: swap === "append", html: format === "html", path,
              entries: new Ring(limit, APPEND_BYTES), removed: []};
            if (b.append) element.replaceChildren();
          }
          b.transform = transform; b.series = null; b.directGraph = false;
          const host = element.closest("[data-sse-graph]");
          if (host && root.contains(host)) {
            if (host === root || host.parentElement.closest("[data-sse-graph]")) throw new Error("Nested/root graph containers are not supported");
            if (swap !== "replace" || format !== "text") throw new Error("Graphs require replace/text bindings");
            const windowSeconds = option(host, "window", 60);
            if (windowSeconds <= 0) throw new Error("Graph window must be positive");
            const min = option(host, "y-min", null), max = option(host, "y-max", null);
            if (min !== null && max !== null && min >= max) throw new Error("Graph y-min must be below y-max");
            const discrete = attr(element, "discrete"), lane = discrete === null ? "" : discrete === "" || discrete === "bus" ? "bus" : discrete === "logic" ? discrete : null;
            if (lane === null) throw new Error("Invalid data-sse-discrete");
            const unit = attr(element, "unit") || "", key = JSON.stringify([name, path, fn, unit, lane]);
            let c = nextChannels.get(key) || channels.get(key);
            if (!c || c.transform !== transform) c = {id: ++serial, event: name, path: attr(element, "json") || "", fn: fn || "", transform, unit, lane,
              values: [], index: new Map(), slots: [], label: attr(element, "label") || name, history: new History(graphBudget - clockBudget), tick: -1};
            if (!hosts.has(host)) hosts.set(host, []);
            const series = hosts.get(host), first = series.find(s => !s.lane);
            if (!lane && first && first.unit !== unit) throw new Error("Use synchronized panels for different units");
            if (!nextChannels.has(key) && (nextChannels.size + 1) * 4096 > graphBudget - clockBudget) throw new Error("Graph budget too small for series count");
            if (!nextChannels.has(key)) c.label = attr(element, "label") || name;
            nextChannels.set(key, c);
            if (!series.includes(c)) series.push(c);
            b.series = c; b.directGraph = element === host;
            if (!b.directGraph) { b.wasHidden = element.hidden; element.hidden = true; }
          }
          next.set(element, b);
          if (!bindings.has(name)) bindings.set(name, []);
          bindings.get(name).push(b);
        } catch (error) { configError(error); }
      }
      channels = nextChannels;
      shareBudget(null);
      for (const [host, series] of hosts) {
        if (!series.length) continue;
        try {
          const key = attr(host, "sync") || host;
          let view = nextGroups.get(key) || groups.get(key);
          if (!view) view = {lo: 0, hi: 1, live: true, window: option(host, "window", 60), history: [], cursor: null, a: null, b: null};
          if (!nextGroups.has(key)) view.window = option(host, "window", 60);
          nextGroups.set(key, view);
          const signature = JSON.stringify([series.map(c => [c.id, c.label]), attr(host, "y-min"), attr(host, "y-max"), attr(host, "window"), attr(host, "label"), attr(host, "title")]);
          let plot = plots.get(host);
          if (plot && (plot.signature !== signature || plot.view !== view)) { plot.destroy(); plot = null; }
          if (!plot) plot = new Plot(host, series, view, {invalidate, extent, restarts: () => restarts,
            cursor: g => { for (const p of plots.values()) if (p.view === g) p.inspect(); }, export: showExports, enlarge, page, now: () => (performance.now() - started) / 1000});
          plot.signature = signature;
          nextPlots.set(host, plot);
        } catch (error) { configError(error); }
      }
      for (const [host, plot] of plots) if (!nextPlots.has(host)) plot.destroy();
      plots = nextPlots; groups = nextGroups; elements = next;
      // Jumping needs two plots; with fewer, the key and its hint go.
      jumpButton.hidden = plots.size < 2;
      for (const p of plots.values()) p.guide.children[8].hidden = jumpButton.hidden;
      if (jumpButton.hidden) jump(false); else if (!menu.hidden) search();
      enlarge(); counters();
    }

    function closeSource() {
      clearTimeout(watchdog);
      if (source) {
        for (const name of events) source.removeEventListener(name, receive);
        source.onopen = source.onerror = null;
        source.close();
        source = null;
      }
    }

    function watch() {
      if (!source || source.readyState !== EventSource.OPEN || !timeout) return;
      const remaining = timeout - (performance.now() - lastReceive);
      if (remaining > 0) { watchdog = setTimeout(watch, remaining); return; }
      setState("Stalled");
      closeSource();
      retryTimer = setTimeout(() => connect(true), 2000);
    }

    function connect(resume) {
      if (dead) return;
      clearTimeout(retryTimer);
      closeSource();
      setState(resume ? "Reconnecting" : "Connecting");
      try {
        const url = new URL(attr(root, "connect"), document.baseURI);
        if (resume) {
          if (lastId) url.searchParams.set("lastEventId", lastId);
          else url.searchParams.delete("lastEventId");
        }
        source = new EventSource(url);
        for (const name of events) source.addEventListener(name, receive);
        source.onopen = event => {
          if (event instanceof MessageEvent) return;
          clock.compare = clock.opened;
          clock.opened = true;
          clock.synced = false;
          setState("Connected");
          lastReceive = performance.now();
          if (timeout) watchdog = setTimeout(watch, timeout);
        };
        source.onerror = event => {
          if (event instanceof MessageEvent) return;
          clearTimeout(watchdog);
          setState(source.readyState === EventSource.CLOSED ? "Disconnected" : "Reconnecting");
        };
      } catch (error) { configError(error); setState("Disconnected"); }
    }

    const rawHeader = "received_at,elapsed_ms,event,last_event_id,data";
    const csvRow = values => values.map(v => '"' + (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v)).replace(/"/g, '""') + '"').join(",");
    const rawRow = row => csvRow([new Date(row.time).toISOString(), row.elapsed.toFixed(3), row.event, row.id, row.data]);
    const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
    let exportVersion = 0, exportBusy = false, exportURLs = [], crcTable;
    // CRC-32 as ZIP requires it; updated chunk by chunk while each CSV is encoded.
    const crc32 = (crc, bytes) => {
      crcTable = crcTable || Int32Array.from({length: 256}, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xEDB88320 ^ n >>> 1 : n >>> 1; return n; });
      for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
      return crc;
    };
    // A store-only ZIP (no compression) built from the prepared CSV Blobs without copying them.
    function zip(entries) {
      const now = new Date(), time = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >> 1;
      const date = now.getFullYear() - 1980 << 9 | now.getMonth() + 1 << 5 | now.getDate();
      const fields = list => {
        const view = new DataView(new ArrayBuffer(list.reduce((n, f) => n + f[0], 0)));
        let at = 0;
        for (const [size, value] of list) { view[size > 2 ? "setUint32" : "setUint16"](at, value, true); at += size; }
        return view;
      };
      const parts = [], central = [];
      let offset = 0, size = 0;
      for (const e of entries) {
        // Version 2.0, UTF-8 names, stored; the same fields appear in both headers.
        const name = new TextEncoder().encode(e.name), common = [[2, 20], [2, 2048], [2, 0], [2, time], [2, date], [4, e.crc], [4, e.size], [4, e.size], [2, name.length], [2, 0]];
        parts.push(fields([[4, 0x04034b50], ...common]), name, e.blob);
        central.push(fields([[4, 0x02014b50], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), name);
        offset += 30 + name.length + e.size; size += 46 + name.length;
      }
      return new Blob([...parts, ...central, fields([[4, 0x06054b50], [4, 0], [2, entries.length], [2, entries.length], [4, size], [4, offset], [2, 0]])], {type: "application/zip"});
    }

    function closeExports() {
      exportVersion++;
      for (const url of exportURLs) URL.revokeObjectURL(url);
      exportURLs = [];
    }

    function exportCSV() {
      const lines = [rawHeader];
      capture.each(row => lines.push(rawRow(row)));
      const csv = lines.join("\r\n") + "\r\n";
      const url = URL.createObjectURL(new Blob([csv], {type: "text/csv;charset=utf-8"}));
      const link = document.createElement("a"); link.href = url; link.download = "sse-" + stamp() + ".csv"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      saved = counts.received; counters();
      return csv;
    }

    async function showExports(selected, interval) {
      if (exportBusy) return;
      closeExports();
      exportBusy = exportButton.disabled = true;
      const created = new Date().toISOString(), version = exportVersion, mark = counts.received, prefix = created.replace(/[:.]/g, "-"), lo = interval ? interval[0] : -Infinity, hi = interval ? interval[1] : Infinity;
      const limit = Math.min(268435456, Math.max(8388608, graphBudget * 8 + capture.budget * 4));
      note.textContent = "Preparing export…";
      const snapshots = [], entries = [], lines = [];
      let memory = 0, rowsMade = 0;
      const check = bytes => { if (memory + bytes > limit) throw new Error("Export exceeds its memory budget. Use Export view for a smaller interval."); };
      const valid = () => !dead && version === exportVersion;
      try {
        const raw = [];
        if (!selected) { check(capture.bytes); capture.each(row => raw.push(row)); memory += capture.bytes; }
        const sourceList = selected || Array.from(channels.values());
        // Check before copying. Snapshot trees and their current chunks are
        // independent of live compaction, so all files share one cutoff.
        check(sourceList.reduce((n, c) => n + c.history.bytes, 0));
        for (const c of sourceList) {
          const h = c.history.copy(lo, hi); memory += h.bytes;
          // A lane also keeps the change before the interval, which sets the value held at its start.
          const start = c.lane && c.history.nearest(lo, true);
          snapshots.push({source: {id: c.id, label: c.label, event: c.event, path: c.path, fn: c.fn, unit: c.unit, lane: c.lane, values: c.values},
            history: h, start: start && start.a[0] < lo ? {a: start.a.slice(), summary: start.summary} : null});
        }
        const markers = restarts.map(m => ({...m})).sort((a, b) => a.time - b.time);
        const encoder = new TextEncoder();
        const file = async (name, header, rows, description) => {
          let chunk = header + "\r\n", size = 0, crc = -1, parts = [];
          const append = () => {
            if (!chunk) return;
            const part = encoder.encode(chunk); check(part.byteLength); memory += part.byteLength; size += part.byteLength; parts.push(part); chunk = "";
            crc = crc32(crc, part);
          };
          for (const line of rows) {
            chunk += line + "\r\n";
            if (chunk.length >= 32768) append();
            if (++rowsMade % 1024 === 0) {
              note.textContent = "Preparing export · " + rowsMade + " rows";
              await new Promise(resolve => setTimeout(resolve, 0));
              if (!valid()) return;
            }
          }
          append(); check(size); // Allow the Blob construction's transient copy.
          entries.push({name, blob: new Blob(parts), crc: (crc ^ -1) >>> 0, size}); parts = [];
          lines.push(name + " · " + description + " · " + size + " bytes");
          await new Promise(resolve => setTimeout(resolve, 0));
        };
        if (!selected) {
          await file("raw-events.csv", rawHeader, (function* () { for (const row of raw) yield rawRow(row); })(), raw.length + " retained original events");
          memory -= raw.reduce((n, row) => n + row.bytes, 0); raw.length = 0;
        }
        const header = "series,event,json_pointer,transform,unit,kind,elapsed_start_s,elapsed_end_s,uptime_start_s,uptime_end_s,segment,value,count,min,max,mean,stddev,first,last,min_elapsed_s,max_elapsed_s,gaps,detected_elapsed_s";
        const laneHeader = "series,event,json_pointer,transform,kind,elapsed_start_s,elapsed_end_s,uptime_start_s,uptime_end_s,segment,value,changes,first,last,detected_elapsed_s";
        const until = (performance.now() - started) / 1000;
        for (const item of snapshots) {
          if (!valid()) return;
          const c = item.source, h = item.history, a = h.range(lo, hi), meta = [c.label, c.event, c.path, c.fn, c.unit];
          const relevant = markers.filter(m => m.detected <= hi && (!a || m.segment >= a[4] || m.detected >= a[0]));
          const rows = function* () {
            let index = 0;
            const markerRow = m => csvRow([...meta, "restart", m.time, m.time, 0, 0, m.segment, null, 0, null, null, null, null, null, null, null, null, 0, m.detected]);
            for (const point of h.rows(lo, hi)) {
              const b = point.a;
              while (index < relevant.length && relevant[index].time <= b[0]) yield markerRow(relevant[index++]);
              const kind = !b[5] ? "gap" : point.summary ? "summary" : "sample";
              yield csvRow([...meta, kind, b[0], b[1], b[2], b[3], b[4], kind === "sample" ? b[8] : null, b[5],
                point.summary && b[5] ? b[6] : null, point.summary && b[5] ? b[7] : null,
                point.summary && b[5] ? b[8] : null, point.summary && b[5] ? b[9] : null,
                point.summary && b[5] ? b[10] : null, point.summary && b[5] ? b[11] : null,
                point.summary && b[5] ? b[12] : null, point.summary && b[5] ? b[13] : null, b[14], null]);
            }
            while (index < relevant.length) yield markerRow(relevant[index++]);
          };
          // Lane files have one row per value held, gap or summary; a value holds until the next change.
          const laneRows = function* () {
            let index = 0, prev = item.start;
            const lane = [c.label, c.event, c.path, c.fn], text = v => v >= 0 ? c.values[v] : null;
            const emit = function* (p, next) {
              const b = p.a, end = next ? next.a[0] : Math.min(hi, until), later = next ? next.a[2] : null, v = b[p.summary ? 11 : 8];
              if (p.summary) yield csvRow([...lane, "summary", b[0], b[1], b[2], b[3], b[4], null, b[15], text(b[10]), text(v), null]);
              if (!p.summary || end > b[1]) yield csvRow([...lane, v >= 0 ? "value" : "gap", b[p.summary ? 1 : 0], end, b[p.summary ? 3 : 2], later, b[4], text(v), null, null, null, null]);
            };
            for (const point of h.rows(lo, hi)) {
              while (index < relevant.length && relevant[index].time <= point.a[0]) yield csvRow([...lane, "restart", relevant[index].time, relevant[index].time, 0, 0, relevant[index].segment, null, null, null, null, relevant[index++].detected]);
              if (prev) yield* emit(prev, point);
              prev = {a: point.a.slice(), summary: point.summary};
            }
            if (prev) yield* emit(prev, null);
            while (index < relevant.length) yield csvRow([...lane, "restart", relevant[index].time, relevant[index].time, 0, 0, relevant[index].segment, null, null, null, null, relevant[index++].detected]);
          };
          const name = "s" + String(c.id).padStart(2, "0") + "-" + (c.label.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 64) || "series") + ".csv";
          await file(name, c.lane ? laneHeader : header, c.lane ? laneRows() : rows(), !a ? "No retained data" : c.lane ? `${a[15]} changes · ${format(a[0])}–${format(a[1])} s · ${c.lane} lane` : `${a[5]} samples · ${format(a[0])}–${format(a[1])} s · samples/summaries explicitly identified`);
          memory -= h.bytes; item.history = null;
        }
        if (valid()) {
          // export.txt describes the snapshot and lists every file, first in the ZIP.
          const text = encoder.encode(["TurboSSE export " + created, interval ? `Plot view, elapsed ${format(lo)}–${format(hi)} s` : "All retained data",
            "Each CSV file contains its retained history and resolution.", "", ...lines, ""].join("\r\n"));
          entries.unshift({name: "export.txt", blob: new Blob([text]), crc: (crc32(-1, text) ^ -1) >>> 0, size: text.length});
          const url = URL.createObjectURL(zip(entries)), link = make("a", "");
          exportURLs.push(url); link.href = url; link.download = "sse-" + prefix + ".zip"; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          note.textContent = "";
          if (!selected) { saved = mark; counters(); }
        }
      } catch (error) {
        if (valid()) note.textContent = error.message;
      } finally { snapshots.length = 0; exportBusy = exportButton.disabled = false; }
    }

    const exportClick = () => showExports();
    const retry = () => connect(true);
    exportButton.addEventListener("click", exportClick);
    retryButton.addEventListener("click", retry);
    jumpButton.addEventListener("click", () => jump(menu.hidden));
    // J or / opens the jump menu, unless you are typing in a field of the page; a press elsewhere closes it.
    on("keydown", event => {
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !typing(event) && !jumpButton.hidden && (event.key === "j" || event.key === "J" || event.key === "/")) { event.preventDefault(); jump(true); }
    });
    on("pointerdown", event => { if (!bar.contains(event.target)) jump(false); });
    on("popstate", () => enlarge());
    on("resize", () => enlarge());
    // Leaving the page loses everything received since the last Export All, so the browser asks first.
    on("beforeunload", event => { if (counts.received > saved) { event.preventDefault(); event.returnValue = true; } });
    try {
      capture = new Ring(number(root, "buffer-events", 10000, 1), number(root, "buffer-bytes", 2097152, 1));
      timeout = number(root, "timeout", 0, 0);
      graphBudget = number(root, "graph-bytes", 33554432, 8192);
      clockBudget = Math.min(32768, Math.floor(graphBudget / 4));
      try { register(uptimeEvent); } catch (error) { configError(error); }
      refresh();
      connect(false);
    } catch (error) {
      capture = capture || new Ring(10000, 2097152);
      configError(error);
      setState("Disconnected");
    }
    counters();
    const counterTimer = setInterval(counters, 1000);
    return {
      refresh, exportCSV, stats,
      destroy() {
        dead = true;
        off.abort();
        closeSource();
        clearTimeout(retryTimer);
        clearInterval(counterTimer);
        cancelAnimationFrame(frame);
        exportButton.removeEventListener("click", exportClick);
        retryButton.removeEventListener("click", retry);
        closeExports();
        bar.remove();
        for (const p of plots.values()) p.destroy();
        for (const b of elements.values()) if (b.series && !b.directGraph) b.element.hidden = b.wasHidden;
        plots.clear(); channels.clear(); groups.clear(); restarts.length = 0;
        dirty.clear();
        bindings.clear();
        elements.clear();
        events.clear();
        capture = null;
      }
    };
  }

  const api = window.TurboSSE = {
    init(root) {
      if (active) return api;
      if (!root) {
        const roots = document.querySelectorAll("[data-sse-connect]");
        if (roots.length > 1) throw new Error("TurboSSE supports one connection root per page");
        root = roots[0];
      }
      if (root) active = start(root);
      return api;
    },
    refresh() { if (active) active.refresh(); else api.init(); return api; },
    exportCSV() { return active ? active.exportCSV() : ""; },
    stats() { return active ? active.stats() : null; },
    destroy() {
      document.removeEventListener("DOMContentLoaded", boot);
      if (active) active.destroy();
      active = null;
    }
  };
  function boot() { api.init(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, {once: true});
  else boot();
})();
