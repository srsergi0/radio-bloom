import json
import os
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, "/app/site-packages")

from SpotipyFree import Spotify

sp = Spotify()
_sp_lock = threading.Lock()


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/health":
            return self._json(200, {"status": "ok"})

        if parsed.path == "/search":
            q = (params.get("q") or [None])[0]
            if not q:
                return self._json(400, {"error": "q param required"})

            try:
                with _sp_lock:
                    results = sp.search(q, limit=1)
                track = results.get("tracks", {}).get("items", [None])[0]
                if not track:
                    return self._json(404, {"error": "not found"})

                srcs = track.get("album", {}).get("coverArt", {}).get("sources", [])
                return self._json(200, {
                    "id": track.get("id", ""),
                    "title": track.get("name", ""),
                    "artist": track["artists"][0]["name"] if track.get("artists") else "",
                    "album": track.get("album", {}).get("name", ""),
                    "albumArt": srcs[-1]["url"] if srcs else "",
                    "duration": round(track.get("duration_ms", 0) / 1000),
                    "spotifyUrl": "https://open.spotify.com/track/" + track.get("id", ""),
                })
            except Exception as e:
                return self._json(500, {"error": str(e)})

        return self._json(404, {"error": "not found"})

    def _json(self, status, data):
        try:
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 4001))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[enricher] ready on :{port}", flush=True)
    server.serve_forever()
