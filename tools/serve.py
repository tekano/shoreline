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

    def do_POST(self):
        # dev only: pages can POST a rendered frame to /__capture?name=x.png
        from urllib.parse import urlparse, parse_qs
        url = urlparse(self.path)
        if url.path == '/__photofix':
            return self.photofix()
        if url.path == '/__surface':
            # dev only: the hand-painted surface map (walney/surface.js), saved with the site's data
            data = self.rfile.read(int(self.headers['Content-Length']))
            if data[1:4] != b'PNG':
                return self.send_error(400)
            with open(os.path.join(root, 'walney', 'data', 'surface.png'), 'wb') as f:
                f.write(data)
            self.send_response(204)
            self.end_headers()
            return
        if url.path != '/__capture':
            return self.send_error(404)
        name = os.path.basename(parse_qs(url.query).get('name', ['capture.png'])[0])
        out = os.path.join(root, 'captures')
        os.makedirs(out, exist_ok=True)
        data = self.rfile.read(int(self.headers['Content-Length']))
        with open(os.path.join(out, name), 'wb') as f:
            f.write(data)
        self.send_response(204)
        self.end_headers()

    def photofix(self):
        # dev only: the Photo ref's "Save fix" stores a hand alignment (heading, pitch, tide, place)
        # for one photo in refs/photos-fix.json, and in refs/photos.json so it applies at once
        import json
        fix = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        name = os.path.basename(fix.pop('file', ''))
        refs = os.path.join(root, 'refs')
        if not name or not os.path.exists(os.path.join(refs, name)):
            return self.send_error(400)
        fp, pp = os.path.join(refs, 'photos-fix.json'), os.path.join(refs, 'photos.json')
        fixes = json.load(open(fp)) if os.path.exists(fp) else {}
        fixes.setdefault(name, {}).update(fix)
        json.dump(fixes, open(fp, 'w'), indent=1)
        if os.path.exists(pp):
            photos = json.load(open(pp))
            for p in photos:
                if p['file'] == name:
                    p.update(fix)
            json.dump(photos, open(pp, 'w'), indent=1)
        self.send_response(204)
        self.end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
handler = functools.partial(NoCache, directory=root)
print(f'Shoreline on http://localhost:{port}')
http.server.ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
