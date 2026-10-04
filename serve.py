#!/usr/bin/env python3
"""Dev server: like `python3 -m http.server`, but tells browsers never to cache.
Plain http.server sends no Cache-Control, so phones keep serving stale JS for minutes after you edit it,
which looks exactly like "my change didn't work"."""
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    http.server.ThreadingHTTPServer(('', port), NoCache).serve_forever()
