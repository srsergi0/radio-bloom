import { readdirSync, statSync } from "fs";
import { join, basename, extname } from "path";
import type { Track, DownloadJob } from "./types";
import { createDownload, updateDownload, getDownload, getAllDownloads as dbGetAll, clearDownloads as dbClear, upsertLibraryTrack } from "./db";

const MUSIC_DIR = process.env.MUSIC_DIR || "/app/music";
const SONGS_DIR = join(MUSIC_DIR, "songs");
const SPOTDL_HOST = process.env.SPOTDL_HOST;

const activeProcesses = new Map<string, any>();
const onCompleteCallbacks = new Map<string, (track: Track) => void>();

let procIdCounter = 0;

export async function downloadFromSpotify(url: string, onComplete?: (track: Track) => void): Promise<DownloadJob> {
  const job = createDownload(url);
  if (onComplete) onCompleteCallbacks.set(job.id, onComplete);
  console.log(`[spotdl] Starting download: ${url}`);

  const args = ["download", url, "--output", SONGS_DIR];
  const cmd = SPOTDL_HOST ? "python3" : "spotdl";
  const cmdArgs = SPOTDL_HOST ? ["-m", "spotdl", ...args] : args;

  const proc = Bun.spawn([cmd, ...cmdArgs], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeProcesses.set(job.id, proc);
  let stderr = "";

  (async () => {
    const reader = proc.stdout?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        console.log(`[spotdl] ${new TextDecoder().decode(value).trim()}`);
      }
    }
  })();

  (async () => {
    const reader = proc.stderr?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderr += new TextDecoder().decode(value);
      }
    }
  })();

  proc.ref();
  proc.unref();

  const exitCode = await proc.exited;
  activeProcesses.delete(job.id);

  if (exitCode === 0) {
    const files = readdirSync(SONGS_DIR)
      .filter((f) => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f))
      .sort((a, b) => {
        try {
          return statSync(join(SONGS_DIR, b)).mtimeMs - statSync(join(SONGS_DIR, a)).mtimeMs;
        } catch {
          return 0;
        }
      });

    if (files.length > 0) {
      const latestFile = files[0];
      const filePath = join(SONGS_DIR, latestFile);
      const name = basename(latestFile, extname(latestFile));

      const track: Track = {
        id: `lib_${Date.now()}`,
        type: "song",
        file: `songs/${latestFile}`,
        title: name,
        duration: Math.floor(statSync(filePath).size / (192 * 1000 / 8)),
        spotifyUrl: url,
        addedAt: new Date().toISOString(),
      };

      upsertLibraryTrack({
        file: track.file,
        type: "song",
        title: track.title,
        duration: track.duration,
        spotify_url: url,
        size: statSync(filePath).size,
        mtime: statSync(filePath).mtime.toISOString(),
      });

      updateDownload(job.id, { status: "done", result: track, completedAt: new Date().toISOString() });
      job.status = "done";
      job.result = track;
      job.completedAt = new Date().toISOString();
      console.log(`[spotdl] Download complete: ${track.title}`);

      const cb = onCompleteCallbacks.get(job.id);
      if (cb) {
        onCompleteCallbacks.delete(job.id);
        cb(track);
      }
    } else {
      updateDownload(job.id, { status: "error", error: "No file found after download", completedAt: new Date().toISOString() });
      job.status = "error";
      job.error = "No file found after download";
    }
  } else {
    updateDownload(job.id, { status: "error", error: stderr || `Exit code ${exitCode}`, completedAt: new Date().toISOString() });
    job.status = "error";
    job.error = stderr || `Exit code ${exitCode}`;
    job.completedAt = new Date().toISOString();
    console.error(`[spotdl] Download failed: ${job.error}`);
  }

  return loadJob(job.id);
}

function loadJob(id: string): DownloadJob {
  return getDownload(id) || { id, url: "", status: "error", error: "Not found", startedAt: new Date().toISOString() };
}

export function getDownloadJob(id: string): DownloadJob | null {
  return getDownload(id);
}

export function getAllDownloads(): DownloadJob[] {
  return dbGetAll();
}

export function cancelDownload(id: string): boolean {
  const proc = activeProcesses.get(id);
  if (proc) {
    try { proc.kill(9); } catch {}
    activeProcesses.delete(id);
    onCompleteCallbacks.delete(id);
    updateDownload(id, { status: "error", error: "Cancelled by user", completedAt: new Date().toISOString() });
    return true;
  }
  return false;
}

export function clearDownloads(): void {
  for (const [id] of activeProcesses) {
    cancelDownload(id);
  }
  dbClear();
}
