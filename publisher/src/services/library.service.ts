import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { Track } from "../domain/types";
import type { FfprobeClient } from "../infrastructure/ffprobe.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { MetadataEnrichmentService } from "./metadata-enrichment.service";

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a)$/i;

export class LibraryService {
  private readonly songsDir: string;
  private readonly interludiosDir: string;
  private enrichQueue = 0;

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly ffprobeClient: FfprobeClient,
    private readonly musicDir: string,
    private readonly metadataEnrichment?: MetadataEnrichmentService,
    private readonly onDeleteCallback?: () => Promise<void>
  ) {
    this.songsDir = join(musicDir, "songs");
    this.interludiosDir = join(musicDir, "interludios");
  }

  public async init(): Promise<void> {
    this.ensureDirs();
  }

  private ensureDirs(): void {
    if (!existsSync(this.songsDir)) mkdirSync(this.songsDir, { recursive: true });
    if (!existsSync(this.interludiosDir)) mkdirSync(this.interludiosDir, { recursive: true });
  }

  private getAllFiles(dir: string): string[] {
    let results: string[] = [];
    if (!existsSync(dir)) return results;
    try {
      const list = readdirSync(dir);
      for (const file of list) {
        const filePath = join(dir, file);
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          results = results.concat(this.getAllFiles(filePath));
        } else if (AUDIO_EXTENSIONS.test(file)) {
          results.push(filePath);
        }
      }
    } catch (err: any) {
      console.error(`[LibraryService] Error reading directory ${dir}:`, err.message);
    }
    return results;
  }

  public async scan(): Promise<void> {
    this.ensureDirs();

    // 1. Scan and upsert physical files recursively
    const songFiles = this.getAllFiles(this.songsDir);
    await this.scanAndUpsertFiles(songFiles, this.songsDir, "song");

    const interludioFiles = this.getAllFiles(this.interludiosDir);
    await this.scanAndUpsertFiles(interludioFiles, this.interludiosDir, "interludio");

    // 2. Prune tracks that no longer exist on disk
    const dbSongs = this.libraryRepo.getAllTracks("song");
    const dbInterludios = this.libraryRepo.getAllTracks("interludio");

    const physicalSongKeys = new Set(
      songFiles.map((f) => {
        const relPath = relative(this.songsDir, f).replace(/\\/g, "/");
        return `songs/${relPath}`;
      })
    );

    const physicalInterludioKeys = new Set(
      interludioFiles.map((f) => {
        const relPath = relative(this.interludiosDir, f).replace(/\\/g, "/");
        return `interludios/${relPath}`;
      })
    );

    for (const track of dbSongs) {
      if (!physicalSongKeys.has(track.file)) {
        this.libraryRepo.removeTrack(track.file);
        console.log(`[LibraryService] Pruned deleted song from DB: ${track.file}`);
      }
    }

    for (const track of dbInterludios) {
      if (!physicalInterludioKeys.has(track.file)) {
        this.libraryRepo.removeTrack(track.file);
        console.log(`[LibraryService] Pruned deleted interludio from DB: ${track.file}`);
      }
    }

    const pendingSongs = this.libraryRepo.getAllTracks("song").filter((t) => !t.spotifyUrl).length;
    console.log(`[LibraryService] Catalog indexed. Pendientes de enriquecer: ${pendingSongs}`);
  }

  private async scanAndUpsertFiles(
    files: string[],
    baseDir: string,
    type: "song" | "interludio"
  ): Promise<void> {
    const prefix = type === "song" ? "songs" : "interludios";
    const existingTracks = this.libraryRepo.getAllTracks(type);

    for (const filePath of files) {
      try {
        const stat = statSync(filePath);
        const relPath = relative(baseDir, filePath).replace(/\\/g, "/");
        const key = `${prefix}/${relPath}`;
        const existing = existingTracks.find((t) => t.file === key);

        if (existing && new Date(stat.mtime.toISOString()) <= new Date(existing.addedAt)) {
          if (!existing.spotifyUrl && type === "song" && this.metadataEnrichment) {
            console.log(
              `[LibraryService][debug] ${key} → spotify_url vacío (existente), encolando enriquecimiento...`
            );
            this.enrichTrackAfterScan(key, existing.title, existing.artist);
          }
          continue;
        }

        const file = basename(filePath);
        const name = basename(file, extname(file));
        const meta = await this.ffprobeClient.extractMetadata(filePath);

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

        if (!meta.spotifyUrl && type === "song") {
          if (existing?.spotifyUrl) {
            console.log(`[LibraryService][debug] ${key} → ya tiene spotify_url, se salta`);
          } else if (this.metadataEnrichment) {
            console.log(
              `[LibraryService][debug] ${key} → spotify_url vacío, encolando enriquecimiento...`
            );
            this.enrichTrackAfterScan(key, meta.title || name, meta.artist);
          }
        }
      } catch (err: any) {
        console.error(`[LibraryService] Failed to index file ${filePath}:`, err.message);
      }
    }
  }

  private async enrichTrackAfterScan(file: string, title: string, artist: string): Promise<void> {
    const order = ++this.enrichQueue;
    const delay = order * 1500;
    console.log(
      `[LibraryService][debug] [#${order}] Encolado "${title}" (${artist}), esperando ${delay}ms...`
    );
    await new Promise((r) => setTimeout(r, delay));
    console.log(`[LibraryService][debug] [#${order}] Enriching "${title}" (${artist})...`);
    try {
      const result = await this.metadataEnrichment!.enrich(title, artist);
      if (result?.spotifyUrl) {
        const _spotifyId = this.libraryRepo.updateSpotifyUrl(file, result.spotifyUrl);
        console.log(`[LibraryService] [#${order}] ✅ Auto-enriched ${file} → ${result.spotifyUrl}`);
      } else {
        console.log(`[LibraryService][debug] [#${order}] ${file} → no se encontró en Spotify`);
      }
    } catch (err: any) {
      console.error(`[LibraryService][debug] [#${order}] ${file} → error: ${err.message}`);
    }
  }

  public async rescan(): Promise<string> {
    await this.scan();
    return "ok";
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

  public getTrackById(id: string): Track | null {
    return this.libraryRepo.getTrackById(id);
  }

  public getTrackByFile(file: string): Track | null {
    return this.libraryRepo.getTrackByFile(file);
  }

  public getTrackByUrl(url: string): Track | null {
    return this.libraryRepo.getTrackByUrl(url);
  }

  public updateSpotifyUrl(file: string, spotifyUrl: string): string | null {
    return this.libraryRepo.updateSpotifyUrl(file, spotifyUrl);
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

  public shutdown(): void {}
}
