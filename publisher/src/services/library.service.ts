import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, watch } from "node:fs";
import { basename, extname, join } from "node:path";
import { LibraryRepository } from "../repositories/sqlite/library.repo";
import { FfprobeClient } from "../infrastructure/ffprobe.client";
import { LibraryStats, Track } from "../domain/types";

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a)$/i;

export class LibraryService {
  private readonly songsDir: string;
  private readonly interludiosDir: string;
  private watchers: any[] = [];

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly ffprobeClient: FfprobeClient,
    private readonly musicDir: string,
    private readonly onDeleteCallback?: () => Promise<void>
  ) {
    this.songsDir = join(musicDir, "songs");
    this.interludiosDir = join(musicDir, "interludios");
  }

  public init(): void {
    this.ensureDirs();
    this.scan();
    this.watchDirectories();
  }

  private ensureDirs(): void {
    if (!existsSync(this.songsDir)) mkdirSync(this.songsDir, { recursive: true });
    if (!existsSync(this.interludiosDir)) mkdirSync(this.interludiosDir, { recursive: true });
  }

  public scan(): LibraryStats {
    this.ensureDirs();
    this.scanAndUpsert(this.songsDir, "song");
    this.scanAndUpsert(this.interludiosDir, "interludio");
    const stats = this.libraryRepo.getStats();
    console.log(`[LibraryService] Catalog indexed: ${stats.totalSongs} songs, ${stats.totalInterludios} interludios.`);
    return stats;
  }

  private scanAndUpsert(dir: string, type: "song" | "interludio"): void {
    const prefix = type === "song" ? "songs" : "interludios";
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => AUDIO_EXTENSIONS.test(f));

    const existingTracks = this.libraryRepo.getAllTracks(type);

    for (const file of files) {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      const key = `${prefix}/${file}`;
      const existing = existingTracks.find((t) => t.file === key);

      if (existing && new Date(stat.mtime.toISOString()) <= new Date(existing.addedAt)) {
        continue;
      }

      const name = basename(file, extname(file));
      const meta = this.ffprobeClient.extractMetadata(filePath);

      this.libraryRepo.upsertTrack({
        file: key,
        type,
        title: meta.title || name,
        artist: meta.artist,
        album: meta.album,
        duration: meta.duration || Math.floor(stat.size / ((192 * 1000) / 8)),
        spotify_url: meta.spotifyUrl,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }

  private watchDirectories(): void {
    this.watchDir(this.songsDir, "song");
    this.watchDir(this.interludiosDir, "interludio");
  }

  private watchDir(dir: string, type: "song" | "interludio") {
    try {
      const watcher = watch(dir, (_event: string, filename: string | null) => {
        if (!filename || !AUDIO_EXTENSIONS.test(filename)) return;

        setTimeout(() => {
          const filePath = join(dir, filename);
          const key = `${type === "song" ? "songs" : "interludios"}/${filename}`;

          if (!existsSync(filePath)) {
            this.libraryRepo.removeTrack(key);
            console.log(`[LibraryService] File removed: ${key}`);
            return;
          }

          this.scanAndUpsert(dir, type);
          console.log(`[LibraryService] File updated/added: ${filename}`);
        }, 1000);
      });
      this.watchers.push(watcher);
      console.log(`[LibraryService] Watching directory: ${dir}`);
    } catch (err: any) {
      console.error(`[LibraryService] Failed to set watch on ${dir}:`, err.message);
    }
  }

  public listSongs(): Track[] {
    return this.libraryRepo.getAllTracks("song");
  }

  public listSongsPage(limit: number, offset: number): { items: Track[]; total: number } {
    return {
      items: this.libraryRepo.getTracksPage("song", limit, offset),
      total: this.libraryRepo.countTracks("song"),
    };
  }

  public listInterludios(): Track[] {
    return this.libraryRepo.getAllTracks("interludio");
  }

  public listInterludiosPage(limit: number, offset: number): { items: Track[]; total: number } {
    return {
      items: this.libraryRepo.getTracksPage("interludio", limit, offset),
      total: this.libraryRepo.countTracks("interludio"),
    };
  }

  public getTrackByFile(file: string): Track | null {
    return this.libraryRepo.getTrack(file);
  }

  public getTrackByUrl(url: string): Track | null {
    return this.libraryRepo.getTrackByUrl(url);
  }

  public deleteTrack(file: string): boolean {
    const fullPath = join(this.musicDir, file);
    if (!existsSync(fullPath)) {
      this.libraryRepo.removeTrack(file);
      return true;
    }
    try {
      unlinkSync(fullPath);
      this.libraryRepo.removeTrack(file);
      if (this.onDeleteCallback) {
        this.onDeleteCallback().catch(() => {});
      }
      console.log(`[LibraryService] Deleted track from disk and catalog: ${file}`);
      return true;
    } catch (err: any) {
      console.error(`[LibraryService] Failed to delete file ${file}:`, err.message);
      return false;
    }
  }

  public getStats(): LibraryStats {
    return this.libraryRepo.getStats();
  }

  public shutdown(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
  }
}
