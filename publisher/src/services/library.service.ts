import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { Track } from "../domain/types";
import type { AudioMetadataClient } from "../infrastructure/audio-metadata.client";
import { spotifySearch } from "../infrastructure/spotify.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a)$/i;

export class LibraryService {
  private readonly songsDir: string;
  private readonly interludiosDir: string;

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly audioMetadataClient: AudioMetadataClient,
    private readonly musicDir: string,
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
          continue;
        }

        const file = basename(filePath);
        const name = basename(file, extname(file));
        const meta = await this.audioMetadataClient.extractMetadata(filePath);

        let title = meta.title || name;
        let artist = meta.artist || "";
        let album = meta.album || "";
        let duration = meta.duration || Math.floor(stat.size / ((192 * 1000) / 8));
        let spotifyUrl = meta.spotifyUrl || "";

        // For songs, try to get metadata from Spotify
        if (type === "song" && !spotifyUrl) {
          // First search: title + artist only (more accurate)
          const queryBasic = artist ? `${title} ${artist}` : title;
          let results = await spotifySearch(queryBasic);
          
          // If no result or album mismatch, try with album
          if (results.length === 0 && album) {
            const queryWithAlbum = `${title} ${artist} ${album}`;
            results = await spotifySearch(queryWithAlbum);
          }
          
          if (results.length > 0) {
            const track = results[0];
            // Verify album match if we have album metadata from file
            if (album && track.album) {
              const fileAlbum = album.toLowerCase().trim();
              const spotifyAlbum = track.album.toLowerCase().trim();
              if (fileAlbum !== spotifyAlbum) {
                console.log(`[LibraryService] ⚠️ Album mismatch: file="${album}" vs spotify="${track.album}"`);
              }
            }
            title = track.title;
            artist = track.artist;
            album = track.album;
            duration = track.duration;
            spotifyUrl = track.spotifyUrl;
            console.log(`[LibraryService] ✅ Spotify found: ${title} — ${artist} (${album})`);
          } else {
            console.log(`[LibraryService] ⚠️ Spotify not found: ${queryBasic}`);
          }
        }

        this.libraryRepo.upsertTrack({
          file: key,
          type,
          title,
          artist,
          album,
          duration,
          spotify_url: spotifyUrl,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      } catch (err: any) {
        console.error(`[LibraryService] Failed to index file ${filePath}:`, err.message);
      }
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
