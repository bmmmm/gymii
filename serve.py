#!/usr/bin/env python3
"""Dev server for gymii: plain http.server with caching disabled, so code
changes always show up on a normal reload (ES modules are cached hard
otherwise). Not needed in production — GitHub Pages handles caching."""

import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    # The stdlib listen backlog is 5. Several local Playwright workers,
    # each opening up to six HTTP/1.0 connections for ~20 ES modules,
    # overflow it, and macOS refuses the overflow instead of queueing it:
    # Chromium then reports "Failed to fetch dynamically imported module"
    # for whichever module lost the race (CI's two cores never got there).
    request_queue_size = 64


if __name__ == '__main__':
    # optional port arg so parallel checkouts can serve side by side
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8437
    http.server.test(HandlerClass=NoCacheHandler, ServerClass=Server, port=port)
