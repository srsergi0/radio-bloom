import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type { Track, DownloadJob, SystemConfig } from "./types";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_PATH = `${DATA_DIR}/radio.db`;

function ensureDir() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let db: Database;

export function initDB(): Database {
  ensureDir();
  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  createTables();
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
    CREATE TABLE IF NOT EXISTS timeline_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_index INTEGER NOT NULL DEFAULT 0,
      is_playing INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_tracks (
      id TEXT PRIMARY KEY,
      pos INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'song',
      file TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      album TEXT DEFAULT '',
      duration REAL NOT NULL DEFAULT 0,
      spotify_url TEXT DEFAULT '',
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  try { db.exec("ALTER TABLE library_tracks ADD COLUMN spotify_url TEXT DEFAULT ''"); } catch {}

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
}

export function getDB(): Database {
  if (!db) return initDB();
  return db;
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
  const d = getDB();
  const config = { ...DEFAULT_CONFIG };
  const rows = d.query("SELECT key, value FROM config").all() as { key: string; value: string }[];
  for (const row of rows) {
    const num = Number(row.value);
    (config as any)[row.key] = isNaN(num) ? row.value : num;
  }
  return config;
}

export function saveConfig(config: SystemConfig) {
  const d = getDB();
  const upsert = d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
  const tx = d.transaction(() => {
    for (const [key, value] of Object.entries(config)) {
      upsert.run(key, String(value));
    }
  });
  tx();
}

export function updateConfig(updates: Partial<SystemConfig>): SystemConfig {
  const config = loadConfig();
  Object.assign(config, updates);
  saveConfig(config);
  return config;
}

// ============================================================
// TIMELINE
// ============================================================

export function loadTimelineMeta() {
  const d = getDB();
  d.exec("INSERT OR IGNORE INTO timeline_meta (id, current_index, is_playing, updated_at) VALUES (1, 0, 0, datetime('now'))");
  const row = d.query("SELECT current_index, is_playing, updated_at FROM timeline_meta WHERE id = 1").get() as any;
  return { currentIndex: row.current_index, isPlaying: !!row.is_playing, updatedAt: row.updated_at };
}

export function saveTimelineMeta(currentIndex: number, isPlaying: boolean) {
  getDB().run("UPDATE timeline_meta SET current_index = ?, is_playing = ?, updated_at = datetime('now') WHERE id = 1", currentIndex, isPlaying ? 1 : 0);
}

export function loadTracks(): Track[] {
  const rows = getDB().query("SELECT * FROM timeline_tracks ORDER BY pos").all() as any[];
  return rows.map((r: any) => ({
    id: r.id,
    type: r.type,
    file: r.file,
    title: r.title,
    artist: r.artist || undefined,
    album: r.album || undefined,
    duration: r.duration,
    spotifyUrl: r.spotify_url || undefined,
    addedAt: r.added_at,
  }));
}

export function addTrack(track: Track): Track[] {
  const d = getDB();
  const maxPos = (d.query("SELECT COALESCE(MAX(pos), -1) + 1 as next FROM timeline_tracks").get() as any).next;
  d.run("INSERT INTO timeline_tracks (id, pos, type, file, title, artist, album, duration, spotify_url, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    track.id, maxPos, track.type, track.file, track.title, track.artist || "", track.album || "", track.duration, track.spotifyUrl || "", track.addedAt);
  return loadTracks();
}

export function insertTrack(index: number, track: Track): Track[] {
  const d = getDB();
  const tx = d.transaction(() => {
    d.run("UPDATE timeline_tracks SET pos = pos + 1 WHERE pos >= ?", index);
    d.run("INSERT INTO timeline_tracks (id, pos, type, file, title, artist, album, duration, spotify_url, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      track.id, index, track.type, track.file, track.title, track.artist || "", track.album || "", track.duration, track.spotifyUrl || "", track.addedAt);
  });
  tx();
  return loadTracks();
}

export function updateTrack(id: string, updates: Partial<Track>): Track | null {
  const d = getDB();
  const existing = d.query("SELECT * FROM timeline_tracks WHERE id = ?").get(id) as any;
  if (!existing) return null;
  const fields: string[] = [];
  const vals: any[] = [];
  if (updates.type !== undefined) { fields.push("type = ?"); vals.push(updates.type); }
  if (updates.file !== undefined) { fields.push("file = ?"); vals.push(updates.file); }
  if (updates.title !== undefined) { fields.push("title = ?"); vals.push(updates.title); }
  if (updates.artist !== undefined) { fields.push("artist = ?"); vals.push(updates.artist); }
  if (updates.album !== undefined) { fields.push("album = ?"); vals.push(updates.album); }
  if (updates.duration !== undefined) { fields.push("duration = ?"); vals.push(updates.duration); }
  if (updates.spotifyUrl !== undefined) { fields.push("spotify_url = ?"); vals.push(updates.spotifyUrl); }
  if (fields.length > 0) {
    vals.push(id);
    d.run(`UPDATE timeline_tracks SET ${fields.join(", ")} WHERE id = ?`, ...vals);
  }
  return { ...existing, ...updates, id: existing.id, file: existing.file } as Track;
}

export function removeTrack(id: string): Track[] {
  const d = getDB();
  d.run("DELETE FROM timeline_tracks WHERE id = ?", id);
  return loadTracks();
}

export function reorderTracks(fromIndex: number, toIndex: number): Track[] {
  const d = getDB();
  const tracks = loadTracks();
  if (fromIndex < 0 || fromIndex >= tracks.length || toIndex < 0 || toIndex >= tracks.length) return tracks;
  const [moved] = tracks.splice(fromIndex, 1);
  tracks.splice(toIndex, 0, moved);
  const tx = d.transaction(() => {
    d.run("DELETE FROM timeline_tracks");
    const insert = d.prepare("INSERT INTO timeline_tracks (id, pos, type, file, title, artist, album, duration, spotify_url, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    tracks.forEach((t, i) => insert.run(t.id, i, t.type, t.file, t.title, t.artist || "", t.album || "", t.duration, t.spotifyUrl || "", t.addedAt));
  });
  tx();
  return loadTracks();
}

export function clearTimeline(): Track[] {
  getDB().run("DELETE FROM timeline_tracks");
  return [];
}

export function getTrackById(id: string): Track | null {
  const row = getDB().query("SELECT * FROM timeline_tracks WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    file: row.file,
    title: row.title,
    artist: row.artist || undefined,
    album: row.album || undefined,
    duration: row.duration,
    spotifyUrl: row.spotify_url || undefined,
    addedAt: row.added_at,
  };
}

// ============================================================
// DOWNLOADS
// ============================================================

export function createDownload(url: string): DownloadJob {
  const d = getDB();
  const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  d.run("INSERT INTO downloads (id, url, status, started_at) VALUES (?, ?, 'downloading', ?)", id, url, now);
  return { id, url, status: "downloading", startedAt: now };
}

export function updateDownload(id: string, updates: Partial<DownloadJob>) {
  const d = getDB();
  const fields: string[] = [];
  const vals: any[] = [];
  if (updates.status) fields.push("status = ?"); vals.push(updates.status);
  if (updates.error) fields.push("error = ?"); vals.push(updates.error);
  if (updates.completedAt) fields.push("completed_at = ?"); vals.push(updates.completedAt);
  if (updates.result) {
    fields.push("result_file = ?"); vals.push(updates.result.file);
    fields.push("result_title = ?"); vals.push(updates.result.title);
    fields.push("result_duration = ?"); vals.push(updates.result.duration);
    fields.push("result_spotify_url = ?"); vals.push(updates.result.spotifyUrl || "");
  }
  if (fields.length > 0) {
    vals.push(id);
    d.run(`UPDATE downloads SET ${fields.join(", ")} WHERE id = ?`, ...vals);
  }
}

export function getDownload(id: string): DownloadJob | null {
  const row = getDB().query("SELECT * FROM downloads WHERE id = ?").get(id) as any;
  if (!row) return null;
  const job: DownloadJob = {
    id: row.id,
    url: row.url,
    status: row.status,
    startedAt: row.started_at,
    error: row.error || undefined,
    completedAt: row.completed_at || undefined,
  };
  if (row.result_file) {
    job.result = {
      id: `lib_${Date.now()}`,
      type: "song",
      file: `songs/${row.result_file}`,
      title: row.result_title,
      duration: row.result_duration,
      spotifyUrl: row.result_spotify_url || undefined,
      addedAt: row.completed_at || row.started_at,
    };
  }
  return job;
}

export function getAllDownloads(): DownloadJob[] {
  const rows = getDB().query("SELECT * FROM downloads ORDER BY started_at DESC").all() as any[];
  return rows.map((r: any) => {
    const job: DownloadJob = {
      id: r.id,
      url: r.url,
      status: r.status,
      startedAt: r.started_at,
      error: r.error || undefined,
      completedAt: r.completed_at || undefined,
    };
    if (r.result_file) {
      job.result = {
        id: `lib_${Date.now()}`,
        type: "song",
        file: `songs/${r.result_file}`,
        title: r.result_title,
        duration: r.result_duration,
        spotifyUrl: r.result_spotify_url || undefined,
        addedAt: r.completed_at || r.started_at,
      };
    }
    return job;
  });
}

export function clearDownloads() {
  getDB().run("DELETE FROM downloads");
}

// ============================================================
// LIBRARY
// ============================================================

function fileToId(file: string): string {
  let hash = 0;
  for (let i = 0; i < file.length; i++) {
    hash = ((hash << 5) - hash) + file.charCodeAt(i);
    hash |= 0;
  }
  return `lib_${Math.abs(hash).toString(36)}`;
}

export function getLibraryTrackByUrl(spotifyUrl: string): Track | null {
  const row = getDB().query("SELECT * FROM library_tracks WHERE spotify_url = ?").get(spotifyUrl) as any;
  if (!row) return null;
  return {
    id: fileToId(row.file),
    type: row.type,
    file: row.file,
    title: row.title,
    artist: row.artist || undefined,
    album: row.album || undefined,
    duration: row.duration,
    spotifyUrl: row.spotify_url || undefined,
    addedAt: row.added_at,
  };
}

export function getLibraryTrack(file: string): Track | null {
  const row = getDB().query("SELECT * FROM library_tracks WHERE file = ?").get(file) as any;
  if (!row) return null;
  return {
    id: fileToId(row.file),
    type: row.type,
    file: row.file,
    title: row.title,
    artist: row.artist || undefined,
    album: row.album || undefined,
    duration: row.duration,
    spotifyUrl: row.spotify_url || undefined,
    addedAt: row.added_at,
  };
}

export function getAllLibraryTracks(type?: string): Track[] {
  let rows: any[];
  if (type) {
    rows = getDB().query("SELECT * FROM library_tracks WHERE type = ? ORDER BY file").all(type) as any[];
  } else {
    rows = getDB().query("SELECT * FROM library_tracks ORDER BY file").all() as any[];
  }
  return rows.map((r: any) => ({
    id: fileToId(r.file),
    type: r.type,
    file: r.file,
    title: r.title,
    artist: r.artist || undefined,
    album: r.album || undefined,
    duration: r.duration,
    spotifyUrl: r.spotify_url || undefined,
    addedAt: r.added_at,
  }));
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
  getDB().run(
    `INSERT OR REPLACE INTO library_tracks (file, type, title, artist, album, duration, spotify_url, added_at, size, mtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT added_at FROM library_tracks WHERE file = ?), datetime('now')), ?, ?)`,
    track.file, track.type, track.title, track.artist || "", track.album || "",
    track.duration, track.spotify_url || "", track.file, track.size, track.mtime
  );
}

export function removeLibraryTrack(file: string) {
  getDB().run("DELETE FROM library_tracks WHERE file = ?", file);
}

export function searchLibrary(query: string): Track[] {
  const q = `%${query}%`;
  const rows = getDB().query(
    "SELECT * FROM library_tracks WHERE title LIKE ? OR artist LIKE ? OR album LIKE ? ORDER BY file"
  ).all(q, q, q) as any[];
  return rows.map((r: any) => ({
    id: fileToId(r.file),
    type: r.type,
    file: r.file,
    title: r.title,
    artist: r.artist || undefined,
    album: r.album || undefined,
    duration: r.duration,
    spotifyUrl: r.spotify_url || undefined,
    addedAt: r.added_at,
  }));
}

export function getLibraryStats() {
  const d = getDB();
  const stats = d.query(`
    SELECT
      COUNT(*) FILTER (WHERE type = 'song') as total_songs,
      COUNT(*) FILTER (WHERE type = 'interludio') as total_interludios,
      COALESCE(SUM(size), 0) as total_size,
      COALESCE(SUM(duration), 0) as total_duration
    FROM library_tracks
  `).get() as any;
  return {
    totalSongs: stats.total_songs,
    totalInterludios: stats.total_interludios,
    totalSizeBytes: stats.total_size,
    totalDurationSeconds: stats.total_duration,
  };
}

