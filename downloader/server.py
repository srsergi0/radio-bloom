import json
import os
import sys
import subprocess
import threading
import shutil
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs
from pathlib import Path
import hashlib
import time
from mutagen import File as MutagenFile


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


SONGS_DIR = os.environ.get("SONGS_DIR", "/music/songs")
VALID_AUDIO_EXTENSIONS = {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".opus"}


def is_valid_audio(file_path: str) -> bool:
    """Check if an audio file is valid using mutagen."""
    try:
        audio = MutagenFile(file_path)
        if audio is None:
            return False
        # Must have a valid duration
        info = audio.info
        if info is None:
            return False
        duration = info.length if hasattr(info, "length") else 0
        if duration <= 0 or duration > 7200:
            return False
        return True
    except Exception:
        return False


def run_download(url: str, dest_dir: str, quality: str = "LOSSLESS") -> dict:
    """Run spotiflac and return result."""
    try:
        cmd = [
            "spotiflac", url, dest_dir,
            "--quality", quality,
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
        files = [f for f in dest_path.rglob("*") if f.is_file() and f.suffix.lower() in VALID_AUDIO_EXTENSIONS]
        if not files:
            return {"error": "No audio files downloaded"}

        # Validate first audio file
        first_file = str(files[0])
        if not is_valid_audio(first_file):
            # Remove invalid file so retry doesn't find stale data
            try:
                os.remove(first_file)
            except Exception:
                pass
            return {"error": f"Downloaded file is corrupt: {files[0].name}"}

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
            quality = body.get("quality", "LOSSLESS")

            if not url:
                return self._json(400, {"error": "url required"})

            # Create unique temp dir
            uid = f"{int(time.time())}_{hashlib.md5(url.encode()).hexdigest()[:6]}"
            temp_dir = os.path.join(SONGS_DIR, f"tmp_download_{uid}")
            os.makedirs(temp_dir, exist_ok=True)

            try:
                # Try LOSSLESS first, fall back to HIGH (MP3) if corrupt
                result = run_download(url, temp_dir, quality)

                # If file is corrupt and quality was LOSSLESS, retry with HIGH (MP3)
                if result.get("error") and "corrupt" in result.get("error", "").lower() and quality == "LOSSLESS":
                    print(f"[downloader] FLAC corrupt, retrying with MP3: {url}")
                    # Recreate temp dir (run_download may have cleaned partial files)
                    os.makedirs(temp_dir, exist_ok=True)
                    result = run_download(url, temp_dir, "HIGH")

                if result.get("error"):
                    return self._json(500, {"error": result["error"]})

                # Move file(s) to songs dir
                temp_path = Path(temp_dir)
                files = [f for f in temp_path.rglob("*") if f.is_file() and f.suffix.lower() in VALID_AUDIO_EXTENSIONS]
                ingested = []

                for f in files:
                    dest = Path(SONGS_DIR) / f.name
                    # Avoid overwriting existing files with corrupt versions
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
