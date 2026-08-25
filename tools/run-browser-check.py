#!/usr/bin/env python3
"""Run tools/browser-check.html in headless Chrome and report what it found.

Serves the project root, opens the harness, and waits for the page to POST its
report back to /__result__. Chrome's --virtual-time-budget is deliberately not
used: it fast-forwards timers, which starves the harness's own polling loops.

Usage:  python tools/run-browser-check.py
"""

import base64
import os
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8123
TIMEOUT = 180

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

report = {}
done = threading.Event()


PIXEL = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/__hold__"):
            # Chrome fires `load` only once this image resolves, which keeps a
            # --screenshot run from capturing the page before it has any data.
            done.wait(TIMEOUT)
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PIXEL)))
            self.end_headers()
            self.wfile.write(PIXEL)
            return
        if self.path.startswith("/__result__"):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            report["failures"] = int(query.get("failures", ["1"])[0])
            report["text"] = base64.b64decode(query.get("b64", [""])[0]).decode("utf-8", "replace")
            self.send_response(204)
            self.end_headers()
            done.set()
            return
        super().do_GET()

    def end_headers(self):
        # Chrome reuses its profile between runs, so without this it will
        # happily assert against a cached copy of a file you just edited.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def find_chrome():
    for path in CHROME_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def main():
    shot = None
    width, height = 390, 900
    args = sys.argv[1:]
    if "--screenshot" in args:
        shot = os.path.abspath(args[args.index("--screenshot") + 1])
        width, height = 940, 2200

    # The report contains non-cp1252 characters (the "approximately" badge).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    chrome = find_chrome()
    if not chrome:
        print("No Chrome/Edge found - skipping browser checks.", file=sys.stderr)
        return 0

    server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=ROOT))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = os.path.join(tempfile.gettempdir(), "awb-matcher-chrome-profile")
    proc = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
         f"--user-data-dir={profile}", f"--window-size={width},{height}"]
        + ([f"--screenshot={shot}"] if shot else [])
        + [f"http://127.0.0.1:{PORT}/tools/browser-check.html"
           + ("?shot=1" if shot else "")],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    try:
        if not done.wait(TIMEOUT):
            print(f"Browser check timed out after {TIMEOUT}s.", file=sys.stderr)
            return 1
        print(report["text"])
        if shot:
            # Chrome writes the screenshot on `load`, which the held image has
            # only just released - let it finish before we pull the plug.
            try:
                proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                pass
            print(f"screenshot: {shot}")
        return 1 if report["failures"] else 0
    finally:
        proc.terminate()
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
