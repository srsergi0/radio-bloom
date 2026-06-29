import json
import os
import subprocess
import shutil
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse
from pathlib import Path
import hashlib
import time
import threading


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


SONGS_DIR = os.environ.get("SONGS_DIR", "/music/songs")
VALID_AUDIO_EXTENSIONS = {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".opus"}
DEFAULT_PRIORITY = os.environ.get(
    "DOWNLOAD_SERVICES",
    "tidal,youtube,deezer,apple,amazon,qobuz"
).split(",")

SERVICE_PRIORITY = list(DEFAULT_PRIORITY)
_tidal_blocked_until = 0.0
_lock = threading.Lock()
_download_lock = threading.Lock()


def _tidal_blocked_in_output(output: str) -> bool:
    keywords = [
        "TRACK_NOT_FOUND",
        "RATE_LIMITED",
        "429",
        "403",
        "401",
        "too many requests",
        "rate limit",
        "quota exceeded",
        "tidal.*not.*found",
        "tidal.*failed",
        "503 Service Unavailable",
    ]
    lower = output.lower()
    for kw in keywords:
        if kw in lower:
            return True
    return False


def _rebalance_services(success: bool):
    global SERVICE_PRIORITY, _tidal_blocked_until
    now = time.time()
    with _lock:
        if success:
            _tidal_blocked_until = 0.0
            if SERVICE_PRIORITY != DEFAULT_PRIORITY:
                SERVICE_PRIORITY = list(DEFAULT_PRIORITY)
                print(f"[downloader] Tidal healthy again — restored default priority: {SERVICE_PRIORITY}", flush=True)
            return

        if _tidal_blocked_until > now:
            return

        if "tidal" not in SERVICE_PRIORITY:
            return

        _tidal_blocked_until = now + 10800
        services = [s for s in SERVICE_PRIORITY if s != "tidal"]
        if "youtube" in services:
            services.insert(0, services.pop(services.index("youtube")))
        services.append("tidal")
        SERVICE_PRIORITY = services
        print(f"[downloader] Tidal BLOCKED for 3h — new priority: {SERVICE_PRIORITY}", flush=True)


def run_download(url: str, dest_dir: str, quality: str = "LOSSLESS") -> dict:
    with _download_lock:
        try:
            with _lock:
                services = list(SERVICE_PRIORITY)
            cmd = [
                "spotiflac", url, dest_dir,
                "--service", *services,
                "--quality", quality,
                "--no-lyrics",
                "--retries", "2",
                "--timeout", "300",
            ]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=400,
                env={**os.environ, "PYTHONIOENCODING": "utf-8"}
            )

            output = (result.stdout + " " + result.stderr).lower()

            if result.returncode != 0:
                if _tidal_blocked_in_output(output):
                    _rebalance_services(success=False)
                return {"error": result.stderr.strip() or f"Exit code {result.returncode}"}

            dest_path = Path(dest_dir)
            files = [f for f in dest_path.rglob("*") if f.is_file() and f.suffix.lower() in VALID_AUDIO_EXTENSIONS]
            if not files:
                if _tidal_blocked_in_output(output):
                    _rebalance_services(success=False)
                return {"error": "No audio files downloaded"}

            if "tidal" in output and "trying" in output and "✓" in output:
                _rebalance_services(success=True)

            return {"filename": files[0].name}

        except subprocess.TimeoutExpired:
            return {"error": "Download timed out (400s)"}
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
            temp_dir = os.path.join(SONGS_DIR, ".tmp", f"download_{uid}")
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

        if parsed.path == "/services":
            with _lock:
                remaining = max(0, int(_tidal_blocked_until - time.time()))
            return self._json(200, {
                "current": SERVICE_PRIORITY,
                "default": DEFAULT_PRIORITY,
                "tidal_blocked": remaining > 0,
                "tidal_block_remaining_s": remaining,
            })

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


def cleanup_orphan_temp_dirs():
    tmp_root = os.path.join(SONGS_DIR, ".tmp")
    if not os.path.isdir(tmp_root):
        return
    for entry in os.listdir(tmp_root):
        entry_path = os.path.join(tmp_root, entry)
        if os.path.isdir(entry_path):
            try:
                shutil.rmtree(entry_path, ignore_errors=True)
                print(f"[downloader] Cleaned orphan temp dir: {entry}", flush=True)
            except:
                pass


if __name__ == "__main__":
    cleanup_orphan_temp_dirs()
    port = int(os.environ.get("PORT", 4002))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[downloader] ready on :{port}", flush=True)
    print(f"[downloader] services: {SERVICE_PRIORITY}", flush=True)
    server.serve_forever()
