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

  const palette = ["#235d9c", "#b04a25", "#247766", "#8051a1", "#9a7017", "#3c7180"];
  const format = value => {
    if (!Number.isFinite(value)) return "—";
    const magnitude = Math.abs(value);
    return magnitude && (magnitude >= 1e6 || magnitude < .001) ? value.toExponential(4).replace(/\.?0+e/, "e") : String(Number(value.toPrecision(5)));
  };
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
      this.hidden = new Set(); this.y = null; this.mode = "Zoom"; this.drag = null;
      this.abort = new AbortController();
      const listen = (node, name, fn, opts = {}) => node.addEventListener(name, fn, {...opts, signal: this.abort.signal});
      this.element = make("section", "turbo-sse-plot", undefined, host);
      this.element.setAttribute("aria-label", attr(host, "label") || sources.map(c => c.label).join(", "));
      this.controls = make("div", "turbo-sse-tools", undefined, this.element);
      for (const action of ["Live", "Fit", "Fit Y", "Back", "Export view"]) {
        const b = make("button", "", action, this.controls); b.type = "button"; b.dataset.action = action;
      }
      this.modeControl = make("select", "", undefined, this.controls);
      this.modeControl.setAttribute("aria-label", "Plot interaction");
      for (const text of ["Zoom", "Pan", "Measure"]) make("option", "", text, this.modeControl);
      listen(this.modeControl, "change", () => { this.mode = this.modeControl.value; });
      this.area = make("div", "turbo-sse-area", undefined, this.element);
      this.canvas = make("canvas", "", undefined, this.area);
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute("role", "img");
      this.canvas.setAttribute("aria-label", this.element.getAttribute("aria-label") + ". Arrows pan; plus/minus zoom; A/B measure; L live; F fit.");
      this.cursor = make("div", "turbo-sse-cursor", undefined, this.area);
      this.horizontal = make("div", "turbo-sse-cross-y", undefined, this.area);
      this.selection = make("div", "turbo-sse-selection", undefined, this.area);
      this.cursor.hidden = this.horizontal.hidden = this.selection.hidden = true;
      this.legend = make("div", "turbo-sse-legend", undefined, this.element);
      this.values = sources.map(c => {
        const b = make("button", "", undefined, this.legend); b.type = "button";
        b.style.setProperty("--series-color", palette[(c.id - 1) % palette.length]);
        b.setAttribute("aria-pressed", "true");
        make("span", "turbo-sse-series-name", c.label, b);
        const value = make("span", "turbo-sse-series-value", "—", b);
        listen(b, "click", event => {
          if (event.shiftKey) { this.hidden = new Set(sources.filter(s => s !== c)); }
          else if (this.hidden.has(c)) this.hidden.delete(c); else this.hidden.add(c);
          this.values.forEach((v, i) => v.parentElement.setAttribute("aria-pressed", String(!this.hidden.has(sources[i]))));
          hooks.invalidate();
        });
        return value;
      });
      this.readout = make("div", "turbo-sse-readout", "Waiting for data", this.element);
      this.measure = make("div", "turbo-sse-measure", undefined, this.element);
      listen(this.controls, "click", event => {
        const action = event.target.dataset.action;
        if (action === "Live") { this.save(); view.live = true; }
        if (action === "Fit") { this.save(); const r = hooks.extent(view); view.lo = r[0]; view.hi = Math.max(r[1], r[0] + .001); view.live = false; }
        if (action === "Fit Y") this.y = null;
        if (action === "Back" && view.history.length) Object.assign(view, view.history.pop());
        if (action === "Export view") hooks.export(sources, view.a !== null && view.b !== null ? [Math.min(view.a, view.b), Math.max(view.a, view.b)] : [view.lo, view.hi]);
        hooks.invalidate();
      });
      listen(this.canvas, "wheel", event => {
        if (document.activeElement !== this.canvas) return;
        event.preventDefault();
        const t = this.time(event), factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY / 300)));
        this.setRange(t + (view.lo - t) * factor, t + (view.hi - t) * factor);
      }, {passive: false});
      listen(this.canvas, "pointerdown", event => {
        if (this.drag || event.button !== 0) return;
        event.preventDefault(); this.canvas.focus(); this.canvas.setPointerCapture(event.pointerId);
        const t = this.time(event);
        this.drag = {x: event.clientX, y: event.clientY, t, lo: view.lo, hi: view.hi, live: view.live, a: view.a, b: view.b, fresh: view.a === null || view.b !== null};
        this.save(); view.live = false; hooks.invalidate();
        if (this.mode === "Measure") { if (this.drag.fresh) view.a = t; view.b = null; }
      });
      listen(this.canvas, "pointermove", event => {
        const t = this.time(event); view.cursor = t;
        this.cursorY = Math.max(12, Math.min(12 + this.height, event.clientY - this.canvas.getBoundingClientRect().top));
        if (this.drag) {
          const d = this.drag;
          if (this.mode === "Pan") {
            const shift = (event.clientX - d.x) * (d.hi - d.lo) / this.width;
            this.setRange(d.lo - shift, d.hi - shift, false);
          } else if (this.mode === "Measure") { view.b = t; hooks.invalidate(); }
          else this.band(d.t, t);
        }
        hooks.cursor(view);
      });
      listen(this.canvas, "pointerup", event => {
        if (!this.drag) return;
        const d = this.drag, t = this.time(event); this.drag = null;
        if (this.mode === "Zoom" && Math.abs(event.clientX - d.x) > 3) {
          if (event.shiftKey && Math.abs(event.clientY - d.y) > 3) {
            const rect = this.canvas.getBoundingClientRect();
            this.y = [this.value(Math.max(d.y, event.clientY) - rect.top), this.value(Math.min(d.y, event.clientY) - rect.top)];
          }
          this.setRange(Math.min(d.t, t), Math.max(d.t, t), false);
        } else if (this.mode === "Measure") {
          view.b = d.fresh && Math.abs(event.clientX - d.x) < 3 ? null : t;
        }
        hooks.invalidate();
      });
      listen(this.canvas, "pointercancel", () => { this.cancel(); });
      listen(this.canvas, "pointerleave", () => { if (!this.drag) { view.cursor = null; this.cursorY = null; hooks.cursor(view); } });
      listen(this.canvas, "keydown", event => {
        const key = event.key.toLowerCase(), span = view.hi - view.lo, center = view.cursor === null ? (view.lo + view.hi) / 2 : view.cursor;
        if (["arrowleft", "arrowright", "+", "=", "-", "a", "b", "l", "f", "escape"].includes(key)) event.preventDefault();
        if (key === "arrowleft" || key === "arrowright") this.setRange(view.lo + span * (key === "arrowleft" ? -.1 : .1), view.hi + span * (key === "arrowleft" ? -.1 : .1));
        if (["+", "=", "-"].includes(key)) { const f = key === "-" ? 1.25 : .8; this.setRange(center + (view.lo - center) * f, center + (view.hi - center) * f); }
        if (key === "a") view.a = center;
        if (key === "b") view.b = center;
        if (key === "escape") { this.cancel(); view.a = view.b = null; }
        if (key === "l" || key === "f") this.controls.querySelector('[data-action="' + (key === "l" ? "Live" : "Fit") + '"]').click();
        hooks.invalidate();
      });
      this.observer = new ResizeObserver(() => hooks.invalidate());
      this.observer.observe(this.area);
    }
    trimHistory() { if (this.view.history.length > 20) this.view.history.shift(); }
    save() { this.view.history.push({lo: this.view.lo, hi: this.view.hi, live: this.view.live}); this.trimHistory(); }
    cancel() {
      if (this.drag) {
        const d = this.drag; Object.assign(this.view, {a: d.a, b: d.b, lo: d.lo, hi: d.hi, live: d.live});
        this.view.history.pop(); this.drag = null;
      }
      this.hooks.invalidate();
    }
    setRange(lo, hi, remember = true) {
      const extent = this.hooks.extent(this.view), span = Math.max(.0001, hi - lo);
      if (lo < extent[0]) { lo = extent[0]; hi = lo + span; }
      if (hi > extent[1]) { hi = Math.max(extent[1], extent[0] + .001); lo = Math.max(extent[0], hi - span); }
      if (remember) this.save();
      Object.assign(this.view, {lo, hi: Math.max(hi, lo + .0001), live: false});
      this.hooks.invalidate();
    }
    time(event) { const rect = this.canvas.getBoundingClientRect(); return this.view.lo + Math.max(0, Math.min(this.width, event.clientX - rect.left - 64)) / this.width * (this.view.hi - this.view.lo); }
    x(t) { return 64 + (t - this.view.lo) / (this.view.hi - this.view.lo) * this.width; }
    value(y) { const f = Math.max(0, Math.min(1, (y - 12) / this.height)); return this.yMax * (1 - f) + this.yMin * f; }
    band(a, b) {
      this.selection.hidden = a === null;
      if (this.selection.hidden) return;
      if (b === null) b = a;
      this.selection.hidden = Math.max(a, b) < this.view.lo || Math.min(a, b) > this.view.hi;
      if (this.selection.hidden) return;
      const x = Math.max(64, Math.min(this.x(a), this.x(b))), end = Math.min(64 + this.width, Math.max(this.x(a), this.x(b)));
      this.selection.style.cssText = `left:${x}px;top:12px;width:${Math.max(0,end-x)}px;height:${this.height}px`;
    }
    inspect() {
      const g = this.view, t = g.cursor;
      this.cursor.hidden = t === null || t < g.lo || t > g.hi;
      if (!this.cursor.hidden) this.cursor.style.cssText = `left:${this.x(t)}px;top:12px;height:${this.height}px`;
      this.horizontal.hidden = this.cursor.hidden || this.cursorY == null;
      if (!this.horizontal.hidden) this.horizontal.style.cssText = `left:64px;top:${this.cursorY}px;width:${this.width}px`;
      this.sources.forEach((c, i) => {
        const point = c.history.nearest(t === null ? g.hi : t, t === null), a = point && point.a;
        this.values[i].textContent = !a || !a[5] ? "—" : (point.summary ? `${format(a[6])}…${format(a[7])} (mean ${format(a[8])}, n=${a[5]})` : format(a[8])) + (c.unit ? " " + c.unit : "");
      });
      if (t !== null) {
        const point = this.sources[0].history.nearest(t), a = point && point.a;
        this.readout.textContent = "Elapsed " + format(t) + " s" + (!a ? "" : point.summary ? ` · summary ${format(a[0])}–${format(a[1])} s` :
          ` · sample ${format(a[0])} s · uptime ${Number.isFinite(a[2]) ? "≈" + format(a[2]) + " s" : "— (unsynchronized)"}`);
      } else this.readout.textContent = this.baseReadout || "Waiting for data";
    }
    draw() {
      if (!this.host.isConnected || !this.area.clientWidth || !this.area.getClientRects().length) return;
      const w = this.area.clientWidth, h = this.area.clientHeight, dpr = Math.min(3, window.devicePixelRatio || 1), g = this.view;
      this.width = Math.max(1, w - 80); this.height = Math.max(1, h - 48);
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) { this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr); }
      const ctx = this.canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      let low = Infinity, high = -Infinity, retained = 0;
      for (const c of this.sources) {
        if (this.hidden.has(c)) continue;
        const a = c.history.range(g.lo, g.hi);
        if (a && a[5]) { low = Math.min(low, a[6]); high = Math.max(high, a[7]); retained += a[5]; }
      }
      if (!Number.isFinite(low)) { low = 0; high = 1; }
      const magnitude = Math.max(Math.abs(low), Math.abs(high)) || 1;
      const pad = Math.max(Number.MIN_VALUE, ((high / magnitude - low / magnitude) || 1) * .06 * magnitude);
      this.yMin = this.y ? this.y[0] : this.min === null ? Math.max(-Number.MAX_VALUE, low - pad) : this.min;
      this.yMax = this.y ? this.y[1] : this.max === null ? Math.min(Number.MAX_VALUE, high + pad) : this.max;
      if (this.yMin >= this.yMax) { this.yMax = Math.min(Number.MAX_VALUE, this.yMin + pad); this.yMin = Math.max(-Number.MAX_VALUE, this.yMin - pad); }
      const scale = Math.max(Math.abs(this.yMin), Math.abs(this.yMax), Number.MIN_VALUE);
      const y = v => 12 + (this.yMax / scale - v / scale) / (this.yMax / scale - this.yMin / scale) * this.height;
      ctx.font = "11px system-ui"; ctx.fillStyle = "#344454"; ctx.strokeStyle = "#dce3e9"; ctx.lineWidth = .7;
      ctx.textAlign = "right";
      for (const v of ticks(this.yMin, this.yMax, 5)) { const p = y(v); ctx.beginPath(); ctx.moveTo(60, p); ctx.lineTo(w - 16, p); ctx.stroke(); ctx.fillText(format(v), 56, p + 4); }
      ctx.textAlign = "center";
      for (const v of ticks(g.lo, g.hi, Math.max(2, this.width / 90))) { const p = this.x(v); ctx.beginPath(); ctx.moveTo(p, 12); ctx.lineTo(p, h - 36); ctx.stroke(); ctx.fillText(format(v), p, h - 20); }
      ctx.fillText("Elapsed time (s)", 64 + this.width / 2, h - 4); ctx.textAlign = "left"; ctx.fillText(this.sources[0].unit, 4, 10);
      ctx.save(); ctx.beginPath(); ctx.rect(64, 12, this.width, this.height); ctx.clip();
      for (const c of this.sources) {
        if (this.hidden.has(c)) continue;
        const color = palette[(c.id - 1) % palette.length]; ctx.strokeStyle = ctx.fillStyle = color; ctx.lineWidth = 1.3; ctx.beginPath();
        let connected = false;
        c.history.query(g.lo, g.hi, Math.min(2048, this.width), (a, summary) => {
          if (!a[5]) { connected = false; return; }
          if (summary || a[14]) {
            ctx.stroke(); ctx.globalAlpha = .12;
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
      ctx.strokeStyle = "#9b5437"; ctx.fillStyle = "#793c25"; ctx.setLineDash([4, 3]);
      for (const marker of this.hooks.restarts()) if (marker.time >= g.lo && marker.time <= g.hi) {
        const x = this.x(marker.time); ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, h - 36); ctx.stroke(); ctx.fillText("≈ restart", x + 4, 24);
      }
      ctx.restore(); ctx.setLineDash([]);
      if (!retained) { ctx.textAlign = "center"; ctx.fillStyle = "#647586"; ctx.fillText("Waiting for valid data", 64 + this.width / 2, h / 2); }
      this.controls.children[0].setAttribute("aria-pressed", String(g.live));
      this.baseReadout = (g.live ? "Live" : "Inspecting") + ` · ${format(g.lo)}–${format(g.hi)} s · ${retained} samples` +
        (this.sources.some(c => c.history.compacted) ? " · older history summarized" : "") +
        (this.sources.some(c => c.history.evicted) ? " · oldest coverage expired" : "") +
        (g.a !== null && g.b === null ? " · A " + format(g.a) + " s" : "");
      this.band(g.a, g.b); this.inspect();
      this.measure.replaceChildren();
      if (g.a !== null && g.b !== null) {
        const lo = Math.min(g.a, g.b), hi = Math.max(g.a, g.b), dt = hi - lo;
        make("p", "", `A ${format(lo)} s · B ${format(hi)} s · Δt ${format(dt)} s · 1/Δt ${format(dt ? 1/dt : NaN)} Hz`, this.measure);
        for (const c of this.sources) {
          if (this.hidden.has(c)) continue;
          const a = c.history.range(lo, hi), left = c.history.nearest(lo), right = c.history.nearest(hi);
          if (!a || !a[5]) continue;
          const sd = a[9];
          let text = `${c.label}: n ${a[5]} · min ${format(a[6])} · max ${format(a[7])} · p-p ${format(a[7]-a[6])} · mean ${format(a[8])} · RMS ${format(Math.hypot(a[8],sd))} · σ ${format(sd)} ${c.unit}`;
          if (left && right && left.a[5] && right.a[5]) {
            const dy = right.a[8]-left.a[8], seconds = right.a[0]-left.a[0];
            text += ` · ${left.summary || right.summary ? "Δmean" : "Δy"} ${format(dy)}`;
            if (!left.summary && !right.summary) text += " · slope " + format(seconds ? dy/seconds : NaN) + "/s";
          }
          if (a[0] < lo || a[1] > hi) text += ` · summary coverage ${format(a[0])}–${format(a[1])} s`;
          make("p", "", text, this.measure);
        }
      }
    }
    destroy() { this.abort.abort(); this.observer.disconnect(); this.element.remove(); }
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
    let graphDirty = false, lastDraw = -Infinity;
    const bar = document.createElement("div");
    bar.className = "turbo-sse-bar";
    bar.innerHTML = '<span class="turbo-sse-status" role="status" aria-live="polite"></span><span class="turbo-sse-counts"></span><button type="button" class="turbo-sse-export">Export CSV</button><button type="button" class="turbo-sse-retry" hidden>Retry</button>';
    const status = bar.children[0];
    const counter = bar.children[1];
    const exportButton = bar.children[2];
    const retryButton = bar.children[3];
    const uptimeDisplay = document.createElement("span");
    uptimeDisplay.className = "turbo-sse-uptime";
    bar.insertBefore(uptimeDisplay, counter);
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

    function counters() {
      const s = stats();
      let text = "Captured: " + s.retained + " · Evicted: " + s.evicted;
      for (const [key, label] of [["omitted", "Omitted"], ["oversized", "Oversized"], ["appendDrops", "Append drops"], ["parseErrors", "JSON errors"], ["transformErrors", "Transform errors"], ["configErrors", "Config errors"], ["clockErrors", "Clock errors"], ["graphErrors", "Graph errors"], ["markerEvictions", "Expired markers"]]) {
        if (s[key]) text += " · " + label + ": " + s[key];
      }
      if (counter.textContent !== text) counter.textContent = text;
      uptimeDisplay.textContent = s.uptime === null ? "Uptime —" + (clock.value === null ? "" : " (unsynchronized)") :
        "Uptime ≈" + [Math.floor(s.uptime / 3600), Math.floor(s.uptime / 60) % 60, Math.floor(s.uptime) % 60].map(v => String(v).padStart(2, "0")).join(":");
      if (Array.from(groups.values()).some(g => g.live)) invalidate();
    }

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
        if (a) { lo = Math.min(lo, a[0]); hi = Math.max(hi, a[1]); }
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
        for (const p of plots.values()) {
          if (p.failed) continue;
          try { p.draw(); }
          catch (error) { counts.graphErrors++; p.failed = true; p.readout.textContent = "Graph error: " + error.message; }
        }
      }
    }

    function receive(event) {
      if (dead) return;
      const elapsed = performance.now();
      lastReceive = elapsed;
      lastId = event.lastEventId;
      counts.received++;
      const record = {time: Date.now(), elapsed: elapsed - started, event: event.type, id: lastId, data: event.data,
        bytes: 2 * (event.type.length + lastId.length + event.data.length)};
      if (omitted.has(event.type)) counts.omitted++;
      else if (!capture.push(record, () => counts.evicted++)) counts.oversized++;
      if (event.type === uptimeEvent) {
        const value = numeric(event.data);
        if (!Number.isFinite(value) || value < 0) counts.clockErrors++;
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
        const y = value === null ? NaN : numeric(value);
        if (value !== null && !Number.isFinite(y)) counts.graphErrors++;
        graphPoint(c, record.elapsed / 1000, uptime(elapsed), y);
        c.text = Number.isFinite(y) ? String(y) : "—";
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
            const unit = attr(element, "unit") || "", key = JSON.stringify([name, path, fn, unit]);
            let c = nextChannels.get(key) || channels.get(key);
            if (!c || c.transform !== transform) c = {id: ++serial, event: name, path: attr(element, "json") || "", fn: fn || "", transform, unit,
              label: attr(element, "label") || name, history: new History(graphBudget - clockBudget), tick: -1};
            if (!hosts.has(host)) hosts.set(host, []);
            const series = hosts.get(host);
            if (series.length && series[0].unit !== unit) throw new Error("Use synchronized panels for different units");
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
          const signature = JSON.stringify([series.map(c => [c.id, c.label]), attr(host, "y-min"), attr(host, "y-max"), attr(host, "window"), attr(host, "label")]);
          let plot = plots.get(host);
          if (plot && (plot.signature !== signature || plot.view !== view)) { plot.destroy(); plot = null; }
          if (!plot) plot = new Plot(host, series, view, {invalidate, extent, restarts: () => restarts,
            cursor: g => { for (const p of plots.values()) if (p.view === g) p.inspect(); }, export: showExports});
          plot.signature = signature;
          nextPlots.set(host, plot);
        } catch (error) { configError(error); }
      }
      for (const [host, plot] of plots) if (!nextPlots.has(host)) plot.destroy();
      plots = nextPlots; groups = nextGroups; elements = next;
      invalidate(); counters();
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
    let exportPanel = null, exportVersion = 0, exportBusy = false, exportURLs = [];

    function closeExports() {
      exportVersion++;
      for (const url of exportURLs) URL.revokeObjectURL(url);
      exportURLs = [];
      if (exportPanel) exportPanel.remove();
      exportPanel = null;
    }

    function exportCSV() {
      const lines = [rawHeader];
      capture.each(row => lines.push(rawRow(row)));
      const csv = lines.join("\r\n") + "\r\n";
      const url = URL.createObjectURL(new Blob([csv], {type: "text/csv;charset=utf-8"}));
      const link = document.createElement("a"); link.href = url; link.download = "sse-" + stamp() + ".csv"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return csv;
    }

    async function showExports(selected, interval) {
      if (exportBusy) return;
      if (!channels.size) { exportCSV(); return; }
      closeExports();
      exportBusy = true;
      const version = exportVersion, prefix = stamp(), lo = interval ? interval[0] : -Infinity, hi = interval ? interval[1] : Infinity;
      const limit = Math.min(268435456, Math.max(8388608, graphBudget * 8 + capture.budget * 4));
      const panel = exportPanel = make("section", "turbo-sse-export-panel", undefined);
      panel.dataset.state = "preparing"; panel.setAttribute("aria-label", "CSV exports");
      bar.after(panel);
      const close = make("button", "", "Close export", panel); close.type = "button"; close.addEventListener("click", closeExports);
      const status = make("p", "", "Preparing a snapshot of retained data…", panel); status.setAttribute("role", "status");
      const links = document.createDocumentFragment(), snapshots = [];
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
          snapshots.push({source: {id: c.id, label: c.label, event: c.event, path: c.path, fn: c.fn, unit: c.unit}, history: h});
        }
        const markers = restarts.map(m => ({...m})).sort((a, b) => a.time - b.time);
        const encoder = new TextEncoder();
        const file = async (name, header, rows, description) => {
          let chunk = header + "\r\n", size = 0, parts = [];
          const append = () => {
            if (!chunk) return;
            const part = encoder.encode(chunk); check(part.byteLength); memory += part.byteLength; size += part.byteLength; parts.push(part); chunk = "";
          };
          for (const line of rows) {
            chunk += line + "\r\n";
            if (chunk.length >= 32768) append();
            if (++rowsMade % 1024 === 0) {
              status.textContent = "Preparing CSV · " + rowsMade + " rows";
              await new Promise(resolve => setTimeout(resolve, 0));
              if (!valid()) return;
            }
          }
          append(); check(size); // Allow the Blob construction's transient copy.
          const blob = new Blob(parts, {type: "text/csv;charset=utf-8"}); parts = [];
          const url = URL.createObjectURL(blob); exportURLs.push(url);
          const row = make("p", "", undefined, links), link = make("a", "", name, row);
          link.href = url; link.download = prefix + "-" + name;
          make("small", "", " · " + description + " · " + size + " bytes", row);
          await new Promise(resolve => setTimeout(resolve, 0));
        };
        if (!selected) {
          await file("raw-events.csv", rawHeader, (function* () { for (const row of raw) yield rawRow(row); })(), raw.length + " retained original events");
          memory -= raw.reduce((n, row) => n + row.bytes, 0); raw.length = 0;
        }
        const header = "series,event,json_pointer,transform,unit,kind,elapsed_start_s,elapsed_end_s,uptime_start_s,uptime_end_s,segment,value,count,min,max,mean,stddev,first,last,min_elapsed_s,max_elapsed_s,gaps,detected_elapsed_s";
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
          const name = "s" + String(c.id).padStart(2, "0") + "-" + (c.label.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 64) || "series") + ".csv";
          await file(name, header, rows(), a ? `${a[5]} samples · ${format(a[0])}–${format(a[1])} s · samples/summaries explicitly identified` : "No retained samples");
          memory -= h.bytes; item.history = null;
        }
        if (valid()) { panel.append(links); status.textContent = "Snapshot ready. Each file contains its retained history and resolution."; panel.dataset.state = "ready"; }
      } catch (error) {
        if (valid()) {
          for (const url of exportURLs) URL.revokeObjectURL(url);
          exportURLs = []; status.textContent = error.message; panel.dataset.state = "error";
        }
      } finally { snapshots.length = 0; exportBusy = false; }
    }

    const exportClick = () => showExports();
    const retry = () => connect(true);
    exportButton.addEventListener("click", exportClick);
    retryButton.addEventListener("click", retry);
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
