import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { Track } from "../domain/types";
import type { AudioMetadataClient } from "../infrastructure/audio-metadata.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a)$/i;

export interface LibraryDeps {
  libraryRepo: LibraryRepository;
  audioMetadataClient: AudioMetadataClient;
  musicDir: string;
  onDeleteCallback?: () => Promise<void>;
}

export interface LibraryService {
  init: () => Promise<void>;
  shutdown: () => void;
  scan: () => Promise<void>;
  rescan: () => Promise<string>;
  listSongs: () => Track[];
  listSongsPage: (limit: number, offset: number) => { items: Track[]; total: number };
  listInterludios: () => Track[];
  listInterludiosPage: (limit: number, offset: number) => { items: Track[]; total: number };
  getTrackById: (id: string) => Track | null;
  getTrackByFile: (file: string) => Track | null;
  getTrackByUrl: (url: string) => Track | null;
  updateSpotifyUrl: (file: string, spotifyUrl: string) => string | null;
  deleteTrack: (file: string) => boolean;
  updateLastPlayedByFile: (file: string) => void;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getAllAudioFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...getAllAudioFiles(fullPath));
      } else if (AUDIO_EXTENSIONS.test(entry) && !entry.startsWith("ai_dj_")) {
        results.push(fullPath);
      }
    }
  } catch (err: any) {
    console.error(`[Library] Error reading ${dir}:`, err.message);
  }
  return results;
}

function fileToDbKey(filePath: string, baseDir: string, prefix: string): string {
  const rel = relative(baseDir, filePath).replace(/\\/g, "/");
  return `${prefix}/${rel}`;
}

async function enrichMetadata(
  filePath: string,
  type: "song" | "interludio",
  client: AudioMetadataClient,
  existingDuration?: number
): Promise<{ title: string; artist: string; album: string; duration: number; spotifyUrl: string }> {
  const name = basename(filePath, extname(filePath));
  const stat = statSync(filePath);

  // If we already have duration from DB, skip ffprobe entirely
  const duration = existingDuration && existingDuration > 0
    ? existingDuration
    : (await client.extractMetadata(filePath)).duration || Math.floor(stat.size / ((192 * 1000) / 8));

  return { title: name, artist: "", album: "", duration, spotifyUrl: "" };
}

async function upsertFiles(
  files: string[],
  baseDir: string,
  type: "song" | "interludio",
  deps: LibraryDeps,
  existingTracksMap?: Map<string, Track>
): Promise<void> {
  const prefix = type === "song" ? "songs" : "interludios";
  // Use pre-loaded map if available, otherwise fetch once
  const existingTracks = existingTracksMap || (() => {
    const tracks = deps.libraryRepo.getAllTracks(type);
    return new Map(tracks.map((t) => [t.file, t]));
  })();

  for (const filePath of files) {
    try {
      const stat = statSync(filePath);
      const key = fileToDbKey(filePath, baseDir, prefix);
      const existing = existingTracks.get(key);

      if (existing?.mtime && stat.mtime.toISOString() === existing.mtime) continue;

      const { title, artist, album, duration, spotifyUrl } = await enrichMetadata(
        filePath,
        type,
        deps.audioMetadataClient,
        existing?.duration
      );

      deps.libraryRepo.upsertTrack({
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
      console.error(`[Library] Failed to index ${filePath}:`, err.message);
    }
  }
}

function removeOrphanedTracks(
  dbTracks: Track[],
  physicalKeys: Set<string>,
  repo: LibraryRepository
): void {
  for (const track of dbTracks) {
    // Only clean orphaned songs - interludios are managed by the queue service
    if (track.type !== "song") continue;
    if (!physicalKeys.has(track.file)) {
      repo.removeTrack(track.file);
      console.log(`[Library] Removed orphaned: ${track.file}`);
    }
  }
}

function buildPhysicalKeys(files: string[], baseDir: string, prefix: string): Set<string> {
  return new Set(files.map((f) => fileToDbKey(f, baseDir, prefix)));
}

async function doScan(deps: LibraryDeps): Promise<void> {
  const songsDir = join(deps.musicDir, "songs");

  ensureDir(songsDir);

  const songFiles = getAllAudioFiles(songsDir);

  // Load tracks once, reuse for upsert and orphan detection
  const existingTracks = new Map(
    deps.libraryRepo.getAllTracks("song").map((t) => [t.file, t])
  );

  await upsertFiles(songFiles, songsDir, "song", deps, existingTracks);

  removeOrphanedTracks(
    Array.from(existingTracks.values()),
    buildPhysicalKeys(songFiles, songsDir, "songs"),
    deps.libraryRepo
  );
}

export function createLibraryService(deps: LibraryDeps): LibraryService {
  const songsDir = join(deps.musicDir, "songs");
  const interludiosDir = join(deps.musicDir, "interludios");

  let watcherTimer: Timer | null = null;
  let scanLock: Promise<void> = Promise.resolve();

  const scan = (): Promise<void> => {
    const run = scanLock.then(() => doScan(deps));
    scanLock = run.then(
      () => {},
      () => {}
    );
    return run;
  };

  return {
    async init() {
      ensureDir(songsDir);
      ensureDir(interludiosDir);
      await scan();
      watcherTimer = setInterval(scan, 15000);
      console.log("[Library] Polling 15s active");
    },

    shutdown() {
      if (watcherTimer) clearInterval(watcherTimer);
    },

    scan,

    async rescan() {
      await scan();
      return "ok";
    },

    listSongs: () => deps.libraryRepo.getAllTracks("song"),

    listSongsPage: (limit, offset) => ({
      items: deps.libraryRepo.getTracksPage("song", limit, offset),
      total: deps.libraryRepo.countTracks("song"),
    }),

    listInterludios: () => deps.libraryRepo.getAllTracks("interludio"),

    listInterludiosPage: (limit, offset) => ({
      items: deps.libraryRepo.getTracksPage("interludio", limit, offset),
      total: deps.libraryRepo.countTracks("interludio"),
    }),

    getTrackById: (id) => deps.libraryRepo.getTrackById(id),
    getTrackByFile: (file) => deps.libraryRepo.getTrackByFile(file),
    getTrackByUrl: (url) => deps.libraryRepo.getTrackByUrl(url),
    updateSpotifyUrl: (file, url) => deps.libraryRepo.updateSpotifyUrl(file, url),

    deleteTrack(file) {
      const fullPath = join(deps.musicDir, file);
      if (existsSync(fullPath)) {
        try {
          unlinkSync(fullPath);
        } catch (err: any) {
          console.error(`[Library] Failed to delete ${file}:`, err.message);
          return false;
        }
      }
      deps.libraryRepo.removeTrack(file);
      deps.onDeleteCallback?.().catch(() => {});
      console.log(`[Library] Deleted: ${file}`);
      return true;
    },

    updateLastPlayedByFile(file) {
      const match = file.replace(/\\/g, "/").match(/(?:^|\/)(songs|interludios)\/(.+)$/);
      const dbFile = match ? `${match[1]}/${match[2]}` : file.replace(/^\/music\//, "");
      const track = deps.libraryRepo.getTrackByFile(dbFile);
      if (track) deps.libraryRepo.updateLastPlayedAt(track.id);
    },
  };
}
