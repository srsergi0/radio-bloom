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
import re

import yt_dlp



class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


SONGS_DIR = os.environ.get("SONGS_DIR", "/music/songs")
VALID_AUDIO_EXTENSIONS = {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".opus"}
EXT_TO_FORMAT = {
    ".flac": "flac",
    ".mp3": "mp3",
    ".m4a": "ipod",
    ".ogg": "ogg",
    ".opus": "opus",
    ".wav": "wav",
}
DEFAULT_PRIORITY = os.environ.get("DOWNLOAD_SERVICES", "").split(",")
if not DEFAULT_PRIORITY or DEFAULT_PRIORITY == [""]:
    raise RuntimeError("DOWNLOAD_SERVICES env var is required")

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


def _sanitize_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    return name.strip()[:200]


def _download_with_ytdlp(url: str, title: str, artist: str, temp_dir: str, send_event):
    """
    Fallback: download best audio from YouTube Music using yt-dlp as Python library.
    No auth, no cookies, no PO token needed for audio-only formats.
    Returns (filename: str | None, error: str | None)
    """
    search_query = f"ytsearch:{title} {artist}" if artist else f"ytsearch:{title}"
    send_event("log", {"message": f"[yt-dlp] Searching: {search_query}"})
    print(f"[yt-dlp] Searching: {search_query}", flush=True)

    ydl_opts = {
        "format": "bestaudio[acodec=opus]/bestaudio/best",
        "outtmpl": str(Path(temp_dir) / "%(title)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "fragment_retries": 3,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "opus",
            }
        ],
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(search_query, download=True)

        if info is None:
            return None, "yt-dlp returned no info"

        entries = []
        if "entries" in info and info["entries"]:
            entries = info["entries"]
        else:
            entries = [info]

        if not entries:
            return None, "No results from yt-dlp"

        entry = entries[0]
        filename = entry.get("title", title)

        temp_path = Path(temp_dir)
        files = [f for f in temp_path.rglob("*") if f.is_file() and f.suffix.lower() in VALID_AUDIO_EXTENSIONS]
        if not files:
            return None, "yt-dlp downloaded but no audio file found in temp dir"

        best = max(files, key=lambda f: f.stat().st_size)
        safe_name = _sanitize_filename(filename) + best.suffix
        final = best.rename(temp_path / safe_name)
        send_event("log", {"message": f"[yt-dlp] Downloaded: {safe_name} ({final.stat().st_size / 1024:.0f} KB)"})
        print(f"[yt-dlp] Downloaded: {safe_name} ({final.stat().st_size / 1024:.0f} KB)", flush=True)
        return final, None

    except Exception as e:
        error_msg = f"yt-dlp failed: {str(e)[:200]}"
        send_event("log", {"message": error_msg})
        print(f"[yt-dlp] Error: {error_msg}", flush=True)
        return None, error_msg


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, data: dict):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/write-metadata":
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            
            file_path = body.get("file")
            title = body.get("title")
            artist = body.get("artist")
            album = body.get("album")
            year = body.get("year")
            genre = body.get("genre")
            track = body.get("track")
            disc = body.get("disc")

            if not file_path:
                return self._json(400, {"error": "file required"})

            # Resolve full path
            full_path = Path(SONGS_DIR) / file_path if not os.path.isabs(file_path) else Path(file_path)
            
            if not full_path.exists():
                return self._json(404, {"error": f"File not found: {file_path}"})

            ext = full_path.suffix.lower()
            format = EXT_TO_FORMAT.get(ext)
            if not format:
                return self._json(400, {"error": f"Unsupported format: {ext}"})

            try:
                # Build ffmpeg args
                meta_args = []
                if title:
                    meta_args.extend(["-metadata", f"title={title}"])
                if artist:
                    meta_args.extend(["-metadata", f"artist={artist}"])
                if album:
                    meta_args.extend(["-metadata", f"album={album}"])
                if year:
                    meta_args.extend(["-metadata", f"date={year}"])
                if genre:
                    meta_args.extend(["-metadata", f"genre={genre}"])
                if track:
                    meta_args.extend(["-metadata", f"track={track}"])
                if disc:
                    meta_args.extend(["-metadata", f"disc={disc}"])

                tmp_file = str(full_path) + ".tmp"

                cmd = [
                    "ffmpeg", "-y",
                    "-i", str(full_path),
                    *meta_args,
                    "-codec", "copy",
                    "-f", format,
                    tmp_file,
                ]

                print(f"[downloader] write-metadata: {' '.join(cmd)}", flush=True)

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )

                if result.returncode != 0:
                    # Cleanup tmp file
                    try:
                        os.unlink(tmp_file)
                    except:
                        pass
                    return self._json(500, {"error": f"ffmpeg failed: {result.stderr[:500]}"})

                # Replace original
                os.replace(tmp_file, str(full_path))

                print(f"[downloader] ✅ Metadata written to {file_path}", flush=True)
                return self._json(200, {"ok": True, "file": file_path})

            except Exception as e:
                # Cleanup tmp file
                try:
                    os.unlink(str(full_path) + ".tmp")
                except:
                    pass
                return self._json(500, {"error": str(e)})

        if parsed.path == "/download":
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            url = body.get("url")
            title = body.get("title")
            artist = body.get("artist")
            quality = body.get("quality", "LOSSLESS")

            if not url:
                return self._json(400, {"error": "url required"})

            # Set up Server-Sent Events (SSE) response stream
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

            def send_event(event_type: str, data: dict):
                try:
                    payload = f"data: {json.dumps({'type': event_type, **data})}\n\n"
                    self.wfile.write(payload.encode("utf-8"))
                    self.wfile.flush()
                except Exception as e:
                    print(f"[downloader] Error sending event: {e}", flush=True)

            uid = f"{int(time.time())}_{hashlib.md5(url.encode()).hexdigest()[:6]}"
            temp_dir = f"/tmp/download_{uid}"
            os.makedirs(temp_dir, exist_ok=True)

            try:
                with _download_lock:
                    yt_downloaded = False

                    # SpotiFLAC con servicios prioritarios
                    with _lock:
                        services = list(SERVICE_PRIORITY)
                    cmd = [
                        "spotiflac", url, temp_dir,
                        "--service", *services,
                        "--quality", quality,
                        "--no-lyrics",
                        "--no-enrich",
                        "--retries", "2",
                        "--timeout", "300",
                    ]

                    send_event("log", {"message": f"Running spotiflac: {' '.join(cmd)}"})

                    process = subprocess.Popen(
                        cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                        env={**os.environ, "PYTHONIOENCODING": "utf-8"}
                    )

                    timeout_seconds = 270
                    timer = threading.Timer(
                        timeout_seconds,
                        lambda: process.kill() if process.poll() is None else None
                    )
                    timer.start()

                    output_lines = []
                    try:
                        while True:
                            line = process.stdout.readline()
                            if not line and process.poll() is not None:
                                break
                            if line:
                                trimmed = line.strip()
                                output_lines.append(trimmed.lower())
                                send_event("log", {"message": trimmed})
                    finally:
                        timer.cancel()

                    process.wait()
                    spotiflac_output = " ".join(output_lines)
                    spotiflac_timed_out = process.returncode in (-9, -15)

                    if process.returncode != 0 and _tidal_blocked_in_output(spotiflac_output):
                        _rebalance_services(success=False)

                    if "tidal" in spotiflac_output and "trying" in spotiflac_output and "✓" in spotiflac_output:
                        _rebalance_services(success=True)

                    temp_path = Path(temp_dir)
                    files = [f for f in temp_path.rglob("*") if f.is_file() and f.suffix.lower() in VALID_AUDIO_EXTENSIONS]

                    # Fallback: si spotiflac no dejó archivos, reintentar sin --no-enrich
                    if not files and (title or artist):
                        send_event("log", {"message": "SpotiFLAC no produjo archivos — reintentando con yt-dlp"})
                        yt_file, yt_err = _download_with_ytdlp(url, title, artist, temp_dir, send_event)
                        if yt_file:
                            files = [yt_file]

                    if not files:
                        if _tidal_blocked_in_output(spotiflac_output):
                            _rebalance_services(success=False)
                        msg = "spotiflac timed out" if spotiflac_timed_out else "No audio files downloaded"
                        send_event("error", {"message": msg})
                        return

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
                        
                        # Copy to a temporary extension on the target volume first,
                        # then rename atomically to prevent Liquidsoap from scanning a partial copy.
                        temp_dest = dest.with_suffix(dest.suffix + ".tmp")
                        shutil.move(str(f), str(temp_dest))
                        temp_dest.rename(dest)
                        ingested.append(dest.name)

                    if not ingested:
                        send_event("error", {"message": "No valid files after download"})
                        return

                    send_event("complete", {"filename": ingested[0]})

            except Exception as e:
                send_event("error", {"message": str(e)})
            finally:
                try:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                except:
                    pass
            return

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
    tmp_root = "/tmp"
    if not os.path.isdir(tmp_root):
        return
    for entry in os.listdir(tmp_root):
        if entry.startswith("download_"):
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
