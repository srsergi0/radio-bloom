import json
import os
import sys
import logging
import threading
import shutil
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse
from pathlib import Path
import hashlib
import time

from backend import SpotiFLAC


logging.basicConfig(level=logging.WARNING, stream=sys.stdout, format="[SpotiFLAC] %(message)s")


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


SONGS_DIR = os.environ.get("SONGS_DIR", "/music/songs")
VALID_AUDIO_EXTENSIONS = {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".opus"}
SERVICE_PRIORITY = os.environ.get(
    "DOWNLOAD_SERVICES",
    "qobuz,tidal,deezer,amazon,apple,youtube"
).split(",")


def run_download(url: str, dest_dir: str, quality: str = "LOSSLESS") -> dict:
    """Download using SpotiFLAC module directly (no subprocess)."""
    try:
        SpotiFLAC(
            url=url,
            output_dir=dest_dir,
            services=SERVICE_PRIORITY,
            quality=quality,
            track_max_retries=2,
            timeout_s=300,
            use_artist_subfolders=False,
            use_album_subfolders=False,
            post_download_action="none",
            log_level=logging.WARNING,
        )

        dest_path = Path(dest_dir)
        files = [f for f in dest_path.rglob("*") if f.is_file() and f.suffix.lower() in VALID_AUDIO_EXTENSIONS]
        if not files:
            return {"error": "No audio files downloaded"}

        return {"filename": files[0].name}

    except Exception as e:
        return {"error": str(e)}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/download":
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            url = body.get("url")
            quality = body.get("quality", "LOSSLESS")

            if not url:
                return self._json(400, {"error": "url required"})

            uid = f"{int(time.time())}_{hashlib.md5(url.encode()).hexdigest()[:6]}"
            temp_dir = os.path.join(SONGS_DIR, f"tmp_download_{uid}")
            os.makedirs(temp_dir, exist_ok=True)

            try:
                result = run_download(url, temp_dir, quality)

                if result.get("error"):
                    return self._json(500, {"error": result["error"]})

                temp_path = Path(temp_dir)
                files = [f for f in temp_path.rglob("*") if f.is_file() and f.suffix.lower() in VALID_AUDIO_EXTENSIONS]
                ingested = []

                for f in files:
                    dest = Path(SONGS_DIR) / f.name
                    if dest.exists():
                        base = dest.stem
                        ext = dest.suffix
                        counter = 1
                        while dest.exists():
                            dest = Path(SONGS_DIR) / f"{base}_{counter}{ext}"
                            counter += 1
                    f.rename(dest)
                    ingested.append(dest.name)

                if not ingested:
                    return self._json(500, {"error": "No valid files after download"})

                return self._json(200, {"filename": ingested[0], "quality": quality})

            finally:
                try:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                except:
                    pass

        return self._json(404, {"error": "not found"})

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            return self._json(200, {"status": "ok"})

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
    port = int(os.environ.get("PORT", 4002))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[downloader] ready on :{port}", flush=True)
    server.serve_forever()
