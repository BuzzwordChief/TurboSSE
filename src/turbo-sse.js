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
  // mean, M2, first/last value, min/max time, gaps, total records.
  const FIELDS = 16, BLOCK = 128, NODE_BYTES = 256, DATA_BYTES = BLOCK * 3 * 8;
  function sample(a, t, u, y, segment) {
    if (!a[15]) { a[0] = t; a[2] = u; a[4] = segment; a[6] = Infinity; a[7] = -Infinity; a[10] = a[11] = NaN; }
    a[1] = t; a[3] = u; a[15]++;
    if (!Number.isFinite(y)) { a[14]++; return a; }
    const n = ++a[5], delta = y - a[8];
    a[8] += delta / n;
    a[9] += delta * (y - a[8]);
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
      c[8] = a[8] + delta * b[5] / n;
      c[9] = a[9] + b[9] + delta * delta * (a[5] / n) * b[5];
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
    nearest(t) {
      let found = null, distance = Infinity;
      for (const n of [...this.roots, this.current]) {
        if (!n) continue;
        const d = Math.max(n.a[0] - t, t - n.a[1], 0);
        if (d <= distance) { found = n; distance = d; }
      }
      if (!found) return null;
      while (found.left) found = t < (found.left.a[1] + found.right.a[0]) / 2 ? found.left : found.right;
      if (!found.data) return {a: found.a, summary: true};
      const data = found.data;
      let lo = 0, hi = found.a[15];
      while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid * 3] <= t) lo = mid + 1; else hi = mid; }
      let i = Math.max(0, lo - 1);
      if (lo < found.a[15] && data[lo * 3] - t < t - data[i * 3]) i = lo;
      const a = sample(new Float64Array(FIELDS), data[i * 3], data[i * 3 + 1], data[i * 3 + 2], found.a[4]);
      return {a, summary: false};
    }
    copy() {
      const h = new History(this.limit);
      const clone = n => n && ({a: n.a.slice(), level: n.level, bytes: n.bytes,
        data: n.data && n.data.slice(), left: clone(n.left), right: clone(n.right)});
      h.roots = this.roots.map(clone); h.current = clone(this.current); h.bytes = this.bytes;
      return h;
    }
  }

  function start(root) {
    const counts = {received: 0, evicted: 0, oversized: 0, parseErrors: 0, transformErrors: 0, configErrors: 0, appendDrops: 0, omitted: 0, clockErrors: 0, restarts: 0};
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
      state = value;
      if (value !== "Connected") clock.synced = false;
      bar.dataset.state = value.toLowerCase();
      status.textContent = value;
      retryButton.hidden = value !== "Disconnected";
    }

    function uptime(time) {
      return clock.synced ? clock.value + (time - clock.at) / 1000 : NaN;
    }

    function stats() {
      const u = uptime(performance.now());
      return Object.assign({}, counts, {state, retained: capture ? capture.size : 0, bytes: capture ? capture.bytes : 0, lastEventId: lastId,
        uptime: Number.isFinite(u) ? u : null, lastUptime: clock.value, segment: clock.segment});
    }

    function counters() {
      const s = stats();
      let text = "Captured: " + s.retained + " · Evicted: " + s.evicted;
      for (const [key, label] of [["omitted", "Omitted"], ["oversized", "Oversized"], ["appendDrops", "Append drops"], ["parseErrors", "JSON errors"], ["transformErrors", "Transform errors"], ["configErrors", "Config errors"], ["clockErrors", "Clock errors"]]) {
        if (s[key]) text += " · " + label + ": " + s[key];
      }
      if (counter.textContent !== text) counter.textContent = text;
      uptimeDisplay.textContent = s.uptime === null ? "Uptime —" + (clock.value === null ? "" : " (unsynchronized)") :
        "Uptime ≈" + [Math.floor(s.uptime / 3600), Math.floor(s.uptime / 60) % 60, Math.floor(s.uptime) % 60].map(v => String(v).padStart(2, "0")).join(":");
    }

    function fragment(element, text, html) {
      if (!html) return document.createTextNode(text);
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.createContextualFragment(text);
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
            if (restarts.length > 256) restarts.shift();
          }
          clock.value = value;
          clock.at = elapsed;
          clock.synced = true;
          clock.compare = false;
        }
      }
      const targets = bindings.get(event.type);
      if (!targets) return;
      let parsed;
      let attempted = false;
      let invalid = false;
      for (const b of targets) {
        if (!root.contains(b.element)) continue;
        let value = event.data;
        if (b.path !== null) {
          if (!attempted) {
            attempted = true;
            try { parsed = JSON.parse(event.data); }
            catch (_) { invalid = true; counts.parseErrors++; }
          }
          if (invalid) continue;
          value = select(parsed, b.path);
          if (value === undefined) continue;
        }
        try {
          if (b.transform) value = b.transform(value);
          value = normalize(value);
        } catch (_) { counts.transformErrors++; continue; }
        if (value === undefined) continue;
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
      const next = new Map();
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
          const name = attr(element, "event");
          register(name);
          const swap = attr(element, "swap") || "replace";
          const format = attr(element, "format") || "text";
          if (!["replace", "append"].includes(swap) || !["text", "html"].includes(format)) throw new Error("Invalid swap or format");
          const path = pointer(attr(element, "json"));
          const fn = attr(element, "transform");
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
          b.transform = transform;
          next.set(element, b);
          if (!bindings.has(name)) bindings.set(name, []);
          bindings.get(name).push(b);
        } catch (error) { configError(error); }
      }
      elements = next;
      counters();
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

    function exportCSV() {
      const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
      const lines = ["received_at,elapsed_ms,event,last_event_id,data"];
      capture.each(row => lines.push([new Date(row.time).toISOString(), row.elapsed.toFixed(3), row.event, row.id, row.data].map(quote).join(",")));
      const csv = lines.join("\r\n") + "\r\n";
      const url = URL.createObjectURL(new Blob([csv], {type: "text/csv;charset=utf-8"}));
      const link = document.createElement("a");
      link.href = url;
      link.download = "sse-" + new Date().toISOString().replace(/[:.]/g, "-") + ".csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return csv;
    }

    const retry = () => connect(true);
    exportButton.addEventListener("click", exportCSV);
    retryButton.addEventListener("click", retry);
    try {
      capture = new Ring(number(root, "buffer-events", 10000, 1), number(root, "buffer-bytes", 2097152, 1));
      timeout = number(root, "timeout", 0, 0);
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
        exportButton.removeEventListener("click", exportCSV);
        retryButton.removeEventListener("click", retry);
        bar.remove();
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
