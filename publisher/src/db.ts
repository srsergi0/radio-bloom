import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import type { DownloadJob, Playlist, PlaylistTrack, SystemConfig, Track } from "./types";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_PATH = `${DATA_DIR}/radio.db`;

function ensureDir() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let db: Database;
let drizzleDb: ReturnType<typeof drizzle<typeof schema>>;

export function initDB(): Database {
  ensureDir();
  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  createTables();
  drizzleDb = drizzle({ client: db, schema });
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS library_tracks (
      file TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'song',
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      album TEXT DEFAULT '',
      duration REAL NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      size INTEGER DEFAULT 0,
      mtime TEXT DEFAULT ''
    )
  `);
  // Add columns that might not exist in older DBs
  try {
    db.exec("ALTER TABLE library_tracks ADD COLUMN spotify_url TEXT DEFAULT ''");
  } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      result_file TEXT DEFAULT '',
      result_title TEXT DEFAULT '',
      result_duration REAL DEFAULT 0,
      result_spotify_url TEXT DEFAULT '',
      error TEXT DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      pos INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'song',
      file TEXT,
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      duration REAL NOT NULL DEFAULT 0,
      spotify_url TEXT DEFAULT '',
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
    )
  `);
}

export function getDB(): Database {
  if (!db) return initDB();
  return db;
}

export function getDrizzle() {
  if (!drizzleDb) initDB();
  return drizzleDb;
}

// ============================================================
// CONFIG
// ============================================================

const DEFAULT_CONFIG: SystemConfig = {
  streamBitrate: 320,
  streamSampleRate: 44100,
  crossfadeDuration: 3,
  playlistReloadSeconds: 30,
};

export function loadConfig(): SystemConfig {
  const d = getDrizzle();
  const config = { ...DEFAULT_CONFIG };
  const rows = d.select().from(schema.config).all();
  for (const row of rows) {
    const num = Number(row.value);
    (config as any)[row.key] = Number.isNaN(num) ? row.value : num;
  }
  return config;
}

export function saveConfig(config: SystemConfig) {
  const d = getDrizzle();
  d.transaction((tx) => {
    for (const [key, value] of Object.entries(config)) {
      tx.insert(schema.config)
        .values({ key, value: String(value) })
        .onConflictDoUpdate({ target: schema.config.key, set: { value: String(value) } })
        .run();
    }
  });
}

export function updateConfig(updates: Partial<SystemConfig>): SystemConfig {
  const config = loadConfig();
  Object.assign(config, updates);
  saveConfig(config);
  return config;
}

// ============================================================
// DOWNLOADS
// ============================================================

export function createDownload(url: string): DownloadJob {
  const d = getDrizzle();
  const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  d.insert(schema.downloads).values({ id, url, status: "downloading", startedAt: now }).run();
  return { id, url, status: "downloading", startedAt: now };
}

export function updateDownload(id: string, updates: Partial<DownloadJob>) {
  const d = getDrizzle();
  const setClause: any = {};
  if (updates.status !== undefined) setClause.status = updates.status;
  if (updates.error !== undefined) setClause.error = updates.error;
  if (updates.completedAt !== undefined) setClause.completedAt = updates.completedAt;
  if (updates.result !== undefined) {
    setClause.resultFile = updates.result.file;
    setClause.resultTitle = updates.result.title;
    setClause.resultDuration = updates.result.duration;
    setClause.resultSpotifyUrl = updates.result.spotifyUrl || "";
  }
  if (Object.keys(setClause).length > 0) {
    d.update(schema.downloads).set(setClause).where(eq(schema.downloads.id, id)).run();
  }
}

export function getDownload(id: string): DownloadJob | null {
  const d = getDrizzle();
  const row = d.select().from(schema.downloads).where(eq(schema.downloads.id, id)).get();
  if (!row) return null;
  const job: DownloadJob = {
    id: row.id,
    url: row.url,
    status: row.status as "queued" | "downloading" | "done" | "error",
    startedAt: row.startedAt,
    error: row.error || undefined,
    completedAt: row.completedAt || undefined,
  };
  if (row.resultFile) {
    job.result = {
      id: `lib_${Date.now()}`,
      type: "song",
      file: `songs/${row.resultFile}`,
      title: row.resultTitle || "",
      duration: row.resultDuration || 0,
      spotifyUrl: row.resultSpotifyUrl || undefined,
      addedAt: row.completedAt || row.startedAt,
    };
  }
  return job;
}

export function getAllDownloads(): DownloadJob[] {
  const d = getDrizzle();
  const rows = d.select().from(schema.downloads).orderBy(desc(schema.downloads.startedAt)).all();
  return rows.map((r) => {
    const job: DownloadJob = {
      id: r.id,
      url: r.url,
      status: r.status as "queued" | "downloading" | "done" | "error",
      startedAt: r.startedAt,
      error: r.error || undefined,
      completedAt: r.completedAt || undefined,
    };
    if (r.resultFile) {
      job.result = {
        id: `lib_${Date.now()}`,
        type: "song",
        file: `songs/${r.resultFile}`,
        title: r.resultTitle || "",
        duration: r.resultDuration || 0,
        spotifyUrl: r.resultSpotifyUrl || undefined,
        addedAt: r.completedAt || r.startedAt,
      };
    }
    return job;
  });
}

export function clearDownloads() {
  getDrizzle().delete(schema.downloads).run();
}

// ============================================================
// LIBRARY
// ============================================================

function fileToId(file: string): string {
  let hash = 0;
  for (let i = 0; i < file.length; i++) {
    hash = (hash << 5) - hash + file.charCodeAt(i);
    hash |= 0;
  }
  return `lib_${Math.abs(hash).toString(36)}`;
}

export function getLibraryTrackByUrl(spotifyUrl: string): Track | null {
  const d = getDrizzle();
  const row = d
    .select()
    .from(schema.libraryTracks)
    .where(eq(schema.libraryTracks.spotifyUrl, spotifyUrl))
    .get();
  if (!row) return null;
  return {
    id: fileToId(row.file),
    type: row.type as "song" | "interludio",
    file: row.file,
    title: row.title,
    artist: row.artist || undefined,
    album: row.album || undefined,
    duration: row.duration,
    spotifyUrl: row.spotifyUrl || undefined,
    addedAt: row.addedAt,
  };
}

export function getLibraryTrack(file: string): Track | null {
  const d = getDrizzle();
  const row = d
    .select()
    .from(schema.libraryTracks)
    .where(eq(schema.libraryTracks.file, file))
    .get();
  if (!row) return null;
  return {
    id: fileToId(row.file),
    type: row.type as "song" | "interludio",
    file: row.file,
    title: row.title,
    artist: row.artist || undefined,
    album: row.album || undefined,
    duration: row.duration,
    spotifyUrl: row.spotifyUrl || undefined,
    addedAt: row.addedAt,
  };
}

export function getAllLibraryTracks(type?: string): Track[] {
  const d = getDrizzle();
  let query = d.select().from(schema.libraryTracks).$dynamic();
  if (type) {
    query = query.where(eq(schema.libraryTracks.type, type));
  }
  const rows = query.orderBy(schema.libraryTracks.file).all();
  return rows.map((r) => ({
    id: fileToId(r.file),
    type: r.type as "song" | "interludio",
    file: r.file,
    title: r.title,
    artist: r.artist || undefined,
    album: r.album || undefined,
    duration: r.duration,
    spotifyUrl: r.spotifyUrl || undefined,
    addedAt: r.addedAt,
  }));
}

export function getLibraryTracksPage(type: string, limit: number, offset: number): Track[] {
  const d = getDrizzle();
  const rows = d
    .select()
    .from(schema.libraryTracks)
    .where(eq(schema.libraryTracks.type, type))
    .orderBy(schema.libraryTracks.file)
    .limit(limit)
    .offset(offset)
    .all();
  return rows.map((r) => ({
    id: fileToId(r.file),
    type: r.type as "song" | "interludio",
    file: r.file,
    title: r.title,
    artist: r.artist || undefined,
    album: r.album || undefined,
    duration: r.duration,
    spotifyUrl: r.spotifyUrl || undefined,
    addedAt: r.addedAt,
  }));
}

export function countLibraryTracks(type: string): number {
  const d = getDrizzle();
  const row = d
    .select({ count: sql<number>`count(*)` })
    .from(schema.libraryTracks)
    .where(eq(schema.libraryTracks.type, type))
    .get();
  return row ? row.count : 0;
}

export function upsertLibraryTrack(track: {
  file: string;
  type: string;
  title: string;
  artist?: string;
  album?: string;
  duration: number;
  spotify_url?: string;
  size: number;
  mtime: string;
}) {
  const d = getDrizzle();
  d.insert(schema.libraryTracks)
    .values({
      file: track.file,
      type: track.type,
      title: track.title,
      artist: track.artist || "",
      album: track.album || "",
      duration: track.duration,
      spotifyUrl: track.spotify_url || "",
      size: track.size,
      mtime: track.mtime,
      addedAt: sql`COALESCE((SELECT added_at FROM library_tracks WHERE file = ${track.file}), datetime('now'))`,
    })
    .onConflictDoUpdate({
      target: schema.libraryTracks.file,
      set: {
        type: track.type,
        title: track.title,
        artist: track.artist || "",
        album: track.album || "",
        duration: track.duration,
        spotifyUrl: track.spotify_url || "",
        size: track.size,
        mtime: track.mtime,
        addedAt: sql`COALESCE((SELECT added_at FROM library_tracks WHERE file = ${track.file}), datetime('now'))`,
      },
    })
    .run();
}

export function removeLibraryTrack(file: string) {
  getDrizzle().delete(schema.libraryTracks).where(eq(schema.libraryTracks.file, file)).run();
}

export function searchLibrary(
  query: string,
  limit = 50,
  offset = 0
): { items: Track[]; total: number } {
  const d = getDrizzle();
  const q = `%${query}%`;
  const totalRow = d
    .select({ count: sql<number>`count(*)` })
    .from(schema.libraryTracks)
    .where(
      or(
        like(schema.libraryTracks.title, q),
        like(schema.libraryTracks.artist, q),
        like(schema.libraryTracks.album, q)
      )
    )
    .get();

  const rows = d
    .select()
    .from(schema.libraryTracks)
    .where(
      or(
        like(schema.libraryTracks.title, q),
        like(schema.libraryTracks.artist, q),
        like(schema.libraryTracks.album, q)
      )
    )
    .orderBy(schema.libraryTracks.file)
    .limit(limit)
    .offset(offset)
    .all();

  return {
    total: totalRow ? totalRow.count : 0,
    items: rows.map((r) => ({
      id: fileToId(r.file),
      type: r.type as "song" | "interludio",
      file: r.file,
      title: r.title,
      artist: r.artist || undefined,
      album: r.album || undefined,
      duration: r.duration,
      spotifyUrl: r.spotifyUrl || undefined,
      addedAt: r.addedAt,
    })),
  };
}

export function getLibraryStats() {
  const d = getDrizzle();
  const stats = d
    .select({
      totalSongs: sql<number>`COUNT(*) FILTER (WHERE type = 'song')`,
      totalInterludios: sql<number>`COUNT(*) FILTER (WHERE type = 'interludio')`,
      totalSize: sql<number>`COALESCE(SUM(size), 0)`,
      totalDuration: sql<number>`COALESCE(SUM(duration), 0)`,
    })
    .from(schema.libraryTracks)
    .get();

  return {
    totalSongs: stats?.totalSongs || 0,
    totalInterludios: stats?.totalInterludios || 0,
    totalSizeBytes: stats?.totalSize || 0,
    totalDurationSeconds: stats?.totalDuration || 0,
  };
}

// ============================================================
// PLAYLISTS
// ============================================================

export function createPlaylist(name: string): Playlist {
  const d = getDrizzle();
  const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  d.insert(schema.playlists).values({ id, name, createdAt: now, updatedAt: now }).run();
  return { id, name, tracks: [], createdAt: now, updatedAt: now };
}

export function listPlaylists(): Playlist[] {
  const d = getDrizzle();
  const rows = d.select().from(schema.playlists).orderBy(desc(schema.playlists.updatedAt)).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tracks: [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export function getPlaylist(id: string): Playlist | null {
  const d = getDrizzle();
  const row = d.select().from(schema.playlists).where(eq(schema.playlists.id, id)).get();
  if (!row) return null;
  const tracks = d
    .select()
    .from(schema.playlistTracks)
    .where(eq(schema.playlistTracks.playlistId, id))
    .orderBy(schema.playlistTracks.pos)
    .all();
  return {
    id: row.id,
    name: row.name,
    tracks: tracks.map((t) => ({
      id: t.id,
      playlistId: t.playlistId,
      pos: t.pos,
      type: t.type as "song" | "interludio",
      file: t.file || undefined,
      title: t.title,
      artist: t.artist || undefined,
      duration: t.duration,
      spotifyUrl: t.spotifyUrl || undefined,
      addedAt: t.addedAt,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function updatePlaylistName(id: string, name: string): boolean {
  const d = getDrizzle();
  const exists = d
    .select({ id: schema.playlists.id })
    .from(schema.playlists)
    .where(eq(schema.playlists.id, id))
    .get();
  if (!exists) return false;
  d.update(schema.playlists)
    .set({ name, updatedAt: sql`datetime('now')` })
    .where(eq(schema.playlists.id, id))
    .run();
  return true;
}

export function deletePlaylist(id: string): boolean {
  const d = getDrizzle();
  d.transaction((tx) => {
    tx.delete(schema.playlistTracks).where(eq(schema.playlistTracks.playlistId, id)).run();
    tx.delete(schema.playlists).where(eq(schema.playlists.id, id)).run();
  });
  return true;
}

export function addPlaylistTrack(
  playlistId: string,
  track: {
    type: string;
    file?: string;
    title: string;
    artist?: string;
    duration: number;
    spotifyUrl?: string;
  }
): PlaylistTrack | null {
  const d = getDrizzle();
  const exists = d
    .select({ id: schema.playlists.id })
    .from(schema.playlists)
    .where(eq(schema.playlists.id, playlistId))
    .get();
  if (!exists) return null;
  const id = `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const maxPosRow = d
    .select({ next: sql<number>`COALESCE(MAX(pos), -1) + 1` })
    .from(schema.playlistTracks)
    .where(eq(schema.playlistTracks.playlistId, playlistId))
    .get();
  const nextPos = maxPosRow ? maxPosRow.next : 0;
  const now = new Date().toISOString();

  d.transaction((tx) => {
    tx.insert(schema.playlistTracks)
      .values({
        id,
        playlistId,
        pos: nextPos,
        type: track.type,
        file: track.file || null,
        title: track.title,
        artist: track.artist || "",
        duration: track.duration,
        spotifyUrl: track.spotifyUrl || "",
        addedAt: now,
      })
      .run();
    tx.update(schema.playlists)
      .set({ updatedAt: sql`datetime('now')` })
      .where(eq(schema.playlists.id, playlistId))
      .run();
  });

  return {
    id,
    playlistId,
    pos: nextPos,
    type: track.type as "song" | "interludio",
    file: track.file,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    spotifyUrl: track.spotifyUrl,
    addedAt: now,
  };
}

export function removePlaylistTrack(playlistId: string, trackId: string): boolean {
  const d = getDrizzle();
  const exists = d
    .select({ id: schema.playlistTracks.id })
    .from(schema.playlistTracks)
    .where(
      and(eq(schema.playlistTracks.id, trackId), eq(schema.playlistTracks.playlistId, playlistId))
    )
    .get();
  if (!exists) return false;

  d.transaction((tx) => {
    tx.delete(schema.playlistTracks)
      .where(
        and(eq(schema.playlistTracks.id, trackId), eq(schema.playlistTracks.playlistId, playlistId))
      )
      .run();
    tx.update(schema.playlists)
      .set({ updatedAt: sql`datetime('now')` })
      .where(eq(schema.playlists.id, playlistId))
      .run();
  });
  return true;
}

export function reorderPlaylistTracks(playlistId: string, trackIds: string[]): boolean {
  const d = getDrizzle();
  d.transaction((tx) => {
    for (let i = 0; i < trackIds.length; i++) {
      tx.update(schema.playlistTracks)
        .set({ pos: i })
        .where(
          and(
            eq(schema.playlistTracks.id, trackIds[i]),
            eq(schema.playlistTracks.playlistId, playlistId)
          )
        )
        .run();
    }
    tx.update(schema.playlists)
      .set({ updatedAt: sql`datetime('now')` })
      .where(eq(schema.playlists.id, playlistId))
      .run();
  });
  return true;
}
