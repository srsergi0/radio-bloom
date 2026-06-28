import json
import os
import sys
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs
from pathlib import Path
import hashlib
import time


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


SONGS_DIR = os.environ.get("SONGS_DIR", "/music/songs")


def run_download(url: str, dest_dir: str) -> dict:
    """Run spotiflac and return result."""
    try:
        cmd = [
            "spotiflac", url, dest_dir,
            "--service", "tidal", "deezer", "soundcloud", "youtube"
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"}
        )

        if result.returncode != 0:
            return {"error": result.stderr.strip() or f"Exit code {result.returncode}"}

        # Find downloaded files
        dest_path = Path(dest_dir)
        files = [f for f in dest_path.rglob("*") if f.is_file()]
        if not files:
            return {"error": "No files downloaded"}

        # Return first file
        return {"filename": files[0].name}

    except subprocess.TimeoutExpired:
        return {"error": "Download timed out (300s)"}
    except Exception as e:
        return {"error": str(e)}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/download":
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            url = body.get("url")

            if not url:
                return self._json(400, {"error": "url required"})

            # Create unique temp dir
            uid = f"{int(time.time())}_{hashlib.md5(url.encode()).hexdigest()[:6]}"
            temp_dir = os.path.join(SONGS_DIR, f"tmp_download_{uid}")
            os.makedirs(temp_dir, exist_ok=True)

            try:
                result = run_download(url, temp_dir)

                if result.get("error"):
                    return self._json(500, {"error": result["error"]})

                # Move file(s) to songs dir
                temp_path = Path(temp_dir)
                files = [f for f in temp_path.rglob("*") if f.is_file()]
                ingested = []

                for f in files:
                    dest = Path(SONGS_DIR) / f.name
                    f.rename(dest)
                    ingested.append(f.name)

                if not ingested:
                    return self._json(500, {"error": "No valid files after download"})

                return self._json(200, {"filename": ingested[0]})

            finally:
                # Cleanup temp dir
                import shutil
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
