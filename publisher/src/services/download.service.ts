import { statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { DownloadJob, Track } from "../domain/types";
import type { FfprobeClient } from "../infrastructure/ffprobe.client";
import type { SpotiflacClient } from "../infrastructure/spotiflac.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";

export class DownloadService {
  private readonly onCompleteCallbacks = new Map<string, (track: Track) => Promise<void>>();
  private processingCount = 0;
  private readonly maxConcurrency = 1;

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly spotiflacClient: SpotiflacClient,
    private readonly ffprobeClient: FfprobeClient,
    private readonly songsDir: string
  ) {}

  public init(): void {
    console.log("[DownloadService] Initializing queue service...");
    // Find downloads that were left in "downloading" status (stuck due to previous process crash) and mark them as error
    try {
      const downloads = this.libraryRepo.getAllDownloads();
      for (const job of downloads) {
        if (job.status === "downloading") {
          console.log(`[DownloadService] Cleaning up stuck downloading job: ${job.id}`);
          this.libraryRepo.updateDownload(job.id, {
            status: "error",
            error: "Interrupted by server restart",
            completedAt: new Date().toISOString(),
          });
        }
      }
    } catch (err: any) {
      console.error("[DownloadService] Error cleaning up stuck downloads:", err.message);
    }

    // Trigger queue processing on startup to resume any remaining queued tasks
    this.triggerQueueProcess();
  }

  private triggerQueueProcess(): void {
    setTimeout(() => {
      this.processQueue().catch((err) => {
        console.error("[DownloadService] Error in processQueue loop:", err.message);
      });
    }, 0);
  }

  private async processQueue(): Promise<void> {
    if (this.processingCount >= this.maxConcurrency) {
      return;
    }

    const nextJob = this.libraryRepo.getNextQueuedDownload();
    if (!nextJob) {
      return;
    }

    this.processingCount++;
    console.log(
      `[DownloadService] Processing job ${nextJob.id} from queue for URL: ${nextJob.url}`
    );

    try {
      // Mark it as downloading in the DB
      this.libraryRepo.updateDownload(nextJob.id, { status: "downloading" });

      const result = await this.spotiflacClient.download(nextJob.url, (line) => {
        console.log(`[DownloadService] [spotiflac-log] ${line}`);
      });

      if (result.error || !result.filename) {
        throw new Error(result.error || "No filename returned from spotiflac");
      }

      const latestFile = result.filename;
      const filePath = join(this.songsDir, latestFile);
      const name = basename(latestFile, extname(latestFile));
      const fileStat = statSync(filePath);

      const meta = this.ffprobeClient.extractMetadata(filePath);

      const track: Track = {
        id: `lib_${Date.now()}`,
        type: "song",
        file: `songs/${latestFile}`,
        title: meta.title || name,
        artist: meta.artist || undefined,
        album: meta.album || undefined,
        duration: meta.duration || Math.floor(fileStat.size / ((192 * 1000) / 8)),
        spotifyUrl: nextJob.url,
        addedAt: new Date().toISOString(),
      };

      this.libraryRepo.upsertTrack({
        file: track.file,
        type: "song",
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        spotify_url: nextJob.url,
        size: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
      });

      this.libraryRepo.updateDownload(nextJob.id, {
        status: "done",
        result: track,
        completedAt: new Date().toISOString(),
      });

      console.log(`[DownloadService] Spotify download job ${nextJob.id} done: ${track.title}`);

      const cb = this.onCompleteCallbacks.get(nextJob.id);
      if (cb) {
        this.onCompleteCallbacks.delete(nextJob.id);
        await cb(track);
      }
    } catch (err: any) {
      console.error(`[DownloadService] Spotify download job ${nextJob.id} failed:`, err.message);
      this.libraryRepo.updateDownload(nextJob.id, {
        status: "error",
        error: err.message,
        completedAt: new Date().toISOString(),
      });
    } finally {
      this.processingCount--;
      // Always trigger another loop in case there are more queued items
      this.triggerQueueProcess();
    }
  }

  public async downloadFromSpotify(
    url: string,
    onComplete?: (track: Track) => Promise<void>
  ): Promise<DownloadJob> {
    const job = this.libraryRepo.createDownload(url);
    if (onComplete) {
      this.onCompleteCallbacks.set(job.id, onComplete);
    }

    console.log(`[DownloadService] Enqueued Spotify download job ${job.id} for: ${url}`);

    // Trigger queue processing asynchronously
    this.triggerQueueProcess();

    return this.getDownloadJob(job.id);
  }

  public reDownload(file: string): DownloadJob | null {
    const track = this.libraryRepo.getTrackByFile(file);
    if (!track) return null;
    if (!track.spotifyUrl) return null;
    const job = this.libraryRepo.createDownload(track.spotifyUrl);
    this.triggerQueueProcess();
    return this.getDownloadJob(job.id);
  }

  public reDownloadMissing(): { file: string; job?: DownloadJob; error?: string }[] {
    const tracks = this.libraryRepo.getAllTracks();
    const results: { file: string; job?: DownloadJob; error?: string }[] = [];
    for (const track of tracks) {
      if (!track.spotifyUrl) continue;
      const fullPath = join(this.songsDir, track.file.replace("songs/", ""));
      try {
        const exists = statSync(fullPath);
        if (exists) continue;
      } catch {
        // file doesn't exist — re-download
      }
      try {
        const job = this.libraryRepo.createDownload(track.spotifyUrl);
        results.push({ file: track.file, job: this.getDownloadJob(job.id) });
      } catch (err: any) {
        results.push({ file: track.file, error: err.message });
      }
    }
    this.triggerQueueProcess();
    return results;
  }

  public getDownloadJob(id: string): DownloadJob {
    const job = this.libraryRepo.getDownload(id);
    return (
      job || {
        id,
        url: "",
        status: "error",
        error: "Not found",
        startedAt: new Date().toISOString(),
      }
    );
  }

  public getAllDownloads(): DownloadJob[] {
    return this.libraryRepo.getAllDownloads();
  }

  public clearDownloads(): void {
    this.libraryRepo.clearDownloads();
  }
}
