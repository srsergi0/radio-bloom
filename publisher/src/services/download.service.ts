import { statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Queue } from "bullmq";
import type { DownloadJob, Track } from "../domain/types";
import type { QueueManager } from "../infrastructure/queue.manager";
import { spotifyGetTrack } from "../infrastructure/spotify.client";
import type { SpotiflacClient } from "../infrastructure/spotiflac.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";

export class DownloadService {
  private readonly onCompleteCallbacks = new Map<string, (track: Track) => Promise<void>>();
  public readonly queue: Queue;

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly spotiflacClient: SpotiflacClient,
    private readonly songsDir: string,
    private readonly queueManager: QueueManager
  ) {
    // 1. Get BullMQ Queue from QueueManager
    this.queue = this.queueManager.getQueue("downloads");
  }

  public async init(): Promise<void> {
    console.log("[DownloadService] Initializing queue service...");

    // 2. Register BullMQ Worker via QueueManager with concurrency = 1
    this.worker = this.queueManager.registerWorker(
      "downloads",
      async (job) => {
        const { url, jobId } = job.data;
        const attemptsMade = job.attemptsMade ?? 0;
        const maxAttempts = job.opts.attempts ?? 1;

        console.log(
          `[DownloadService] Processing job ${jobId} (Attempt ${attemptsMade + 1}/${maxAttempts}) from Redis queue for URL: ${url}`
        );

        // Sync SQLite status to "downloading"
        this.libraryRepo.updateDownload(jobId, { status: "downloading" });

        try {
          const result = await this.spotiflacClient.download(url, async (line) => {
            console.log(`[DownloadService] [spotiflac-log] ${line}`);
            await job.log(line).catch(() => {});
          });

          if (result.error || !result.filename) {
            throw new Error(result.error || "No filename returned from spotiflac");
          }

          const latestFile = result.filename;
          const filePath = join(this.songsDir, latestFile);
          const fileStat = statSync(filePath);

          // Metadata from Spotify API
          const spotifyTrack = await spotifyGetTrack(url);

          const track: Track = {
            id: `lib_${Date.now()}`,
            type: "song",
            file: `songs/${latestFile}`,
            title: spotifyTrack?.title || basename(latestFile, extname(latestFile)),
            artist: spotifyTrack?.artist || undefined,
            album: spotifyTrack?.album || undefined,
            duration: spotifyTrack?.duration || Math.floor(fileStat.size / ((192 * 1000) / 8)),
            spotifyUrl: url,
            addedAt: new Date().toISOString(),
          };

          this.libraryRepo.upsertTrack({
            file: track.file,
            type: "song",
            title: track.title,
            artist: track.artist,
            album: track.album,
            duration: track.duration,
            spotify_url: url,
            size: fileStat.size,
            mtime: fileStat.mtime.toISOString(),
          });

          // Sync SQLite status to "done"
          this.libraryRepo.updateDownload(jobId, {
            status: "done",
            result: track,
            completedAt: new Date().toISOString(),
          });

          console.log(`[DownloadService] Spotify download job ${jobId} done: ${track.title}`);

          const cb = this.onCompleteCallbacks.get(jobId);
          if (cb) {
            this.onCompleteCallbacks.delete(jobId);
            await cb(track);
          }
        } catch (err: any) {
          const isLastAttempt = attemptsMade + 1 >= maxAttempts;
          console.error(
            `[DownloadService] Spotify download job ${jobId} failed (Attempt ${attemptsMade + 1}/${maxAttempts}):`,
            err.message
          );

          // Sync SQLite status: mark as error only on final attempt, otherwise keep in queued status
          this.libraryRepo.updateDownload(jobId, {
            status: isLastAttempt ? "error" : "queued",
            error: `Attempt ${attemptsMade + 1}/${maxAttempts} failed: ${err.message}`,
            completedAt: isLastAttempt ? new Date().toISOString() : undefined,
          });

          throw err; // Propagate to BullMQ so it marks the job as failed and schedules a retry
        }
      },
      {
        concurrency: 1,
      }
    );

    // 3. Find downloads left in "downloading" status (server crash) and mark them as error,
    // and restore any "queued" downloads from SQLite into Redis queue.
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
        } else if (job.status === "queued") {
          console.log(`[DownloadService] Restoring queued job to Redis queue: ${job.id}`);
          await this.queue
            .add(
              "download",
              { url: job.url, jobId: job.id },
              {
                jobId: job.id,
                attempts: 3,
                backoff: {
                  type: "exponential",
                  delay: 5000,
                },
                timeout: 300_000,
              }
            )
            .catch((err) => {
              console.error(
                `[DownloadService] Failed to restore job ${job.id} to Redis:`,
                err.message
              );
            });
        }
      }
    } catch (err: any) {
      console.error("[DownloadService] Error cleaning up/restoring downloads:", err.message);
    }
  }

  public async downloadFromSpotify(
    url: string,
    onComplete?: (track: Track) => Promise<void>
  ): Promise<DownloadJob> {
    // 1. Persist to SQLite DB
    const job = this.libraryRepo.createDownload(url);
    if (onComplete) {
      this.onCompleteCallbacks.set(job.id, onComplete);
    }

    console.log(`[DownloadService] Enqueued Spotify download job ${job.id} for: ${url}`);

    // 2. Enqueue in BullMQ Redis queue with robustness options
    await this.queue.add(
      "download",
      { url, jobId: job.id },
      {
        jobId: job.id,
        attempts: 3, // Retry up to 3 times
        backoff: {
          type: "exponential",
          delay: 5000, // Wait 5s, then 10s, then 20s...
        },
        timeout: 300_000, // Cancel and retry/fail if it hangs for more than 5 minutes
      }
    );

    return this.getDownloadJob(job.id);
  }

  public async downloadAndWait(url: string): Promise<Track> {
    // We register the job and return a promise waiting for the complete callback
    const job = this.libraryRepo.createDownload(url);
    console.log(`[DownloadService] downloadAndWait job ${job.id} for: ${url}`);

    const promise = new Promise<Track>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.onCompleteCallbacks.delete(job.id);
        reject(new Error(`Download timeout for ${url}`));
      }, 600_000);

      this.onCompleteCallbacks.set(job.id, async (track: Track) => {
        clearTimeout(timeout);
        this.onCompleteCallbacks.delete(job.id);
        resolve(track);
      });
    });

    // Enqueue in BullMQ with robustness options
    await this.queue.add(
      "download",
      { url, jobId: job.id },
      {
        jobId: job.id,
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        timeout: 300_000, // Timeout after 5 minutes
      }
    );

    return promise;
  }

  public async reDownload(file: string): Promise<DownloadJob | null> {
    const track = this.libraryRepo.getTrackByFile(file);
    if (!track) return null;
    if (!track.spotifyUrl) return null;
    return this.downloadFromSpotify(track.spotifyUrl);
  }

  public async reDownloadMissing(): Promise<{ file: string; job?: DownloadJob; error?: string }[]> {
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
        const job = await this.downloadFromSpotify(track.spotifyUrl);
        results.push({ file: track.file, job });
      } catch (err: any) {
        results.push({ file: track.file, error: err.message });
      }
    }
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

  public async clearDownloads(): Promise<void> {
    this.libraryRepo.clearDownloads();
    await this.queue.drain().catch(() => {});
    await this.queue.clean(0, 1000, "completed").catch(() => {});
    await this.queue.clean(0, 1000, "failed").catch(() => {});
  }
}
