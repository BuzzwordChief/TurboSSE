"""Real HTTP/SSE fixture shared by browser tests and the benchmark."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlsplit
import uuid

from examples.server import encode_event


ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(ROOT / ".playwright"))


class StreamCase:
    def __init__(self, html):
        self.html = html
        self.frames = []
        self.requests = []
        self.condition = threading.Condition()
        self.generation = 0
        self.status = 200

    def emit(self, name, data, event_id=None):
        with self.condition:
            if event_id is None:
                event_id = "boot:" + str(len(self.frames) + 1)
            self.frames.append((event_id, encode_event(data, name, event_id)))
            self.condition.notify_all()
            return event_id

    def wire(self, data):
        with self.condition:
            self.frames.append((None, data))
            self.condition.notify_all()

    def disconnect(self):
        with self.condition:
            self.generation += 1
            self.condition.notify_all()


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), FixtureHandler)
        self.cases = {}
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return "http://127.0.0.1:" + str(self.server_port)

    def add(self, markup, attributes="", functions="", asset=None):
        key = uuid.uuid4().hex
        asset = asset or os.environ.get("TURBO_SSE_ASSET", "dist/turbo-sse.min.js")
        html = ('<!doctype html><html><head><meta charset="utf-8">'
                '<link rel="stylesheet" href="/dist/turbo-sse.css">'
                '<script>' + functions + '</script><script defer src="/' + asset + '"></script>'
                '</head><body data-sse-connect="/events/' + key + '" ' + attributes + '>'
                + markup + '</body></html>')
        case = StreamCase(html)
        self.cases[key] = case
        return case, self.url + "/case/" + key

    def close(self):
        self.stopped.set()
        for case in self.cases.values():
            case.disconnect()
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_GET(self):
        request = urlsplit(self.path)
        if request.path.startswith("/events/"):
            self.stream(self.server.cases[request.path.split("/")[-1]], parse_qs(request.query))
            return
        if request.path.startswith("/case/"):
            body = self.server.cases[request.path.split("/")[-1]].html.encode("utf-8")
            kind = "text/html; charset=utf-8"
        elif request.path in ("/dist/turbo-sse.min.js", "/src/turbo-sse.js", "/dist/turbo-sse.css"):
            body = (ROOT / request.path.lstrip("/")).read_bytes()
            kind = "text/css" if request.path.endswith(".css") else "text/javascript"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def stream(self, case, query):
        self.close_connection = True
        with case.condition:
            cursor_id = self.headers.get("Last-Event-ID", query.get("lastEventId", [""])[0])
            case.requests.append({"header": self.headers.get("Last-Event-ID"), "query": query, "cursor": cursor_id})
            status = case.status
            generation = case.generation
            cursor = 0
            if cursor_id:
                for index, (event_id, _) in enumerate(case.frames):
                    if event_id == cursor_id:
                        cursor = index + 1
            case.condition.notify_all()
        self.send_response(status)
        self.send_header("Connection", "close")
        if status != 200:
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(b"retry: 50\n\n")
            self.wfile.flush()
            while not self.server.stopped.is_set():
                with case.condition:
                    if case.generation != generation:
                        return
                    frames = case.frames[cursor:]
                    cursor += len(frames)
                    if not frames:
                        case.condition.wait(timeout=.1)
                # Comments let handlers detect disconnected clients, but must not reset the watchdog.
                self.wfile.write(b"".join(frame for _, frame in frames) or b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
