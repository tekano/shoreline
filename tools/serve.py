"""Local dev server with caching off, so a reload always picks up shader edits.

    python tools/serve.py [port]    then open http://localhost:8792
"""
import functools, http.server, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/gzip'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
handler = functools.partial(NoCache, directory=root)
print(f'Shoreline on http://localhost:{port}')
http.server.ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
