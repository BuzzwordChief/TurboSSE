#!/usr/bin/env python3
"""A dependency-free Python 3.9 SSE device simulator. Run from any directory."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import threading
import time
from urllib.parse import parse_qs, urlsplit
import uuid


ROOT = Path(__file__).resolve().parents[1]
ASSETS = {
    "/": (ROOT / "examples/index.html", "text/html; charset=utf-8"),
    "/debug-transforms.js": (ROOT / "examples/debug-transforms.js", "text/javascript; charset=utf-8"),
    "/demo.css": (ROOT / "examples/demo.css", "text/css; charset=utf-8"),
    "/turbo-sse.min.js": (ROOT / "dist/turbo-sse.min.js", "text/javascript; charset=utf-8"),
    "/turbo-sse.css": (ROOT / "dist/turbo-sse.css", "text/css; charset=utf-8"),
}


def encode_event(data, event=None, event_id=None):
    """Encode a string payload, including empty strings and trailing newlines.

    SSE normalizes CR and CRLF to LF. None omits id; an empty id resets the cursor.
    JSON is opt-in on the sender: pass json.dumps(your_object) as data.
    """
    if not isinstance(data, str):
        raise TypeError("SSE data must be a string")
    lines = []
    for field, value in (("id", event_id), ("event", event)):
        if value is not None:
            if not isinstance(value, str) or any(c in value for c in "\r\n\0"):
                raise ValueError("Invalid SSE " + field)
            lines.append(field + ": " + value)
    data = data.replace("\r\n", "\n").replace("\r", "\n")
    lines.extend("data: " + line for line in data.split("\n"))
    return ("\n".join(lines) + "\n\n").encode("utf-8")


class DeviceServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, rate=5.0, disconnect_every=0.0, stall_after=0.0):
        super().__init__(address, Handler)
        self.rate = rate
        self.disconnect_every = disconnect_every
        self.stall_after = stall_after
        self.boot = uuid.uuid4().hex[:8]
        self.sequence = 0
        self.lock = threading.Lock()
        self.stopped = threading.Event()

    def next_id(self):
        with self.lock:
            self.sequence += 1
            return self.boot + ":" + str(self.sequence)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        request = urlsplit(self.path)
        if request.path == "/events":
            self.stream(parse_qs(request.query))
            return
        asset = ASSETS.get(request.path)
        if asset is None:
            self.send_error(404)
            return
        path, content_type = asset
        try:
            content = path.read_bytes()
        except FileNotFoundError:
            self.send_error(503, "Build assets with python tools/build.py first")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def stream(self, query):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        device = self.server
        resume = self.headers.get("Last-Event-ID", query.get("lastEventId", [""])[0])
        started = time.monotonic()
        tick = 0

        def send(name, data):
            self.wfile.write(encode_event(data, name, device.next_id()))

        try:
            self.wfile.write(b"retry: 2000\n\n")
            send("log", "Connected; refreshing snapshot" + (" after " + resume if resume else "") + "\n")
            while not device.stopped.is_set():
                elapsed = time.monotonic() - started
                if device.disconnect_every and elapsed >= device.disconnect_every:
                    return
                if device.stall_after and elapsed >= device.stall_after:
                    device.stopped.wait(0.1)
                    continue
                temperature = 23.6 + 2 * math.sin(time.monotonic() / 8)
                send("temperature", "{:.2f}".format(temperature))
                send("telemetry", json.dumps({"rpm": int(1450 + 60 * math.sin(elapsed)), "voltage": round(12.4 + .1 * math.cos(elapsed), 2)}, separators=(",", ":")))
                if tick % 5 == 0:
                    send("log", "sample {}: temperature {:.2f} °C\n".format(tick, temperature))
                    send("diagnostic", "uptime={:.1f}s free_heap=32768".format(elapsed))
                    send("status", "<strong>Running</strong>")
                send("heartbeat", "alive")
                self.wfile.flush()
                tick += 1
                device.stopped.wait(1 / device.rate)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--rate", type=float, default=5, help="Sample groups per second (0.1–1000)")
    parser.add_argument("--disconnect-every", type=float, default=0, metavar="SECONDS")
    parser.add_argument("--stall-after", type=float, default=0, metavar="SECONDS")
    args = parser.parse_args()
    if not math.isfinite(args.rate) or not .1 <= args.rate <= 1000:
        parser.error("--rate must be between 0.1 and 1000")
    for value in (args.disconnect_every, args.stall_after):
        if not math.isfinite(value) or value < 0:
            parser.error("Fault durations must be finite and nonnegative")
    server = DeviceServer((args.host, args.port), args.rate, args.disconnect_every, args.stall_after)
    print("Device demo: http://{}:{}".format(args.host, server.server_port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.stopped.set()
        server.server_close()


if __name__ == "__main__":
    main()
