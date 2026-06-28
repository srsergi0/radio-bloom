import { SpotdlClient } from "../infrastructure/spotdl.client";
import { LibraryRepository } from "../repositories/sqlite/library.repo";
import { FfprobeClient } from "../infrastructure/ffprobe.client";
import { DownloadJob, Track } from "../domain/types";
import { join, basename, extname } from "node:path";
import { statSync } from "node:fs";

export class DownloadService {
  private readonly onCompleteCallbacks = new Map<string, (track: Track) => Promise<void>>();

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly spotdlClient: SpotdlClient,
    private readonly ffprobeClient: FfprobeClient,
    private readonly songsDir: string
  ) {}

  public async downloadFromSpotify(
    url: string,
    onComplete?: (track: Track) => Promise<void>
  ): Promise<DownloadJob> {
    const job = this.libraryRepo.createDownload(url);
    if (onComplete) {
      this.onCompleteCallbacks.set(job.id, onComplete);
    }

    console.log(`[DownloadService] Starting Spotify download job ${job.id} for: ${url}`);

    // Execute the download asynchronously in the background
    (async () => {
      try {
        const result = await this.spotdlClient.download(url, (line) => {
          console.log(`[DownloadService] [spotdl-log] ${line}`);
        });

        if (result.error || !result.filename) {
          throw new Error(result.error || "No filename returned from spotdl");
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

        this.libraryRepo.updateDownload(job.id, {
          status: "done",
          result: track,
          completedAt: new Date().toISOString(),
        });

        console.log(`[DownloadService] Spotify download job ${job.id} done: ${track.title}`);

        const cb = this.onCompleteCallbacks.get(job.id);
        if (cb) {
          this.onCompleteCallbacks.delete(job.id);
          await cb(track);
        }
      } catch (err: any) {
        console.error(`[DownloadService] Spotify download job ${job.id} failed:`, err.message);
        this.libraryRepo.updateDownload(job.id, {
          status: "error",
          error: err.message,
          completedAt: new Date().toISOString(),
        });
      }
    })();

    return this.getDownloadJob(job.id);
  }

  public getDownloadJob(id: string): DownloadJob {
    const job = this.libraryRepo.getDownload(id);
    return job || {
      id,
      url: "",
      status: "error",
      error: "Not found",
      startedAt: new Date().toISOString(),
    };
  }

  public getAllDownloads(): DownloadJob[] {
    return this.libraryRepo.getAllDownloads();
  }

  public clearDownloads(): void {
    this.libraryRepo.clearDownloads();
  }
}
