#!/usr/bin/env python3
"""Dev server for gymii: plain http.server with caching disabled, so code
changes always show up on a normal reload (ES modules are cached hard
otherwise). Not needed in production — GitHub Pages handles caching."""

import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    http.server.test(HandlerClass=NoCacheHandler, port=8437)
