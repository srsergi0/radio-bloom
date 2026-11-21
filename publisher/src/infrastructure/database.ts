import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../repositories/sqlite/schema";

export class DatabaseConnection {
  public readonly client: Database;
  public readonly drizzle: ReturnType<typeof drizzle>;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.client = new Database(dbPath);
    this.client.exec("PRAGMA journal_mode = WAL");
    this.client.exec("PRAGMA busy_timeout = 5000");
    this.client.exec("PRAGMA foreign_keys = ON");

    this.createTables();

    this.drizzle = drizzle({ client: this.client, schema });
  }

  private createTables() {
    this.client.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.client.exec(`
      CREATE TABLE IF NOT EXISTS library_tracks (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'song',
        title TEXT NOT NULL,
        artist TEXT DEFAULT '',
        album TEXT DEFAULT '',
        duration REAL NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        size INTEGER DEFAULT 0,
        mtime TEXT DEFAULT '',
        spotify_url TEXT DEFAULT '',
        last_played_at TEXT DEFAULT '',
        script TEXT DEFAULT ''
      )
    `);

    // Migrate from old schema (file as PK) to new schema (id as PK)
    const cols = this.client.query("PRAGMA table_info(library_tracks)").all() as any[];
    const hasId = cols.some((c: any) => c.name === "id");
    if (!hasId) {
      this.client.exec("ALTER TABLE library_tracks ADD COLUMN id TEXT");
    }
    try {
      this.client.exec("ALTER TABLE library_tracks ADD COLUMN spotify_url TEXT DEFAULT ''");
    } catch {}
    try {
      this.client.exec("ALTER TABLE library_tracks ADD COLUMN last_played_at TEXT DEFAULT ''");
    } catch {}
    try {
      this.client.exec("ALTER TABLE library_tracks ADD COLUMN script TEXT DEFAULT ''");
    } catch {}

    // Ensure unique index on file for upsert (upsertTrack uses ON CONFLICT(file))
    // First deduplicate any rows with the same file (keep the one with most data)
    try {
      this.client.exec(`
        DELETE FROM library_tracks WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM library_tracks GROUP BY file
        )
      `);
      this.client.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_library_tracks_file ON library_tracks(file)"
      );
    } catch {}

    try {
      this.client.exec("DROP TABLE IF EXISTS playback_state");
    } catch {}
    // Migrate queue_persistence: add columns if missing (created as IF NOT EXISTS)
    try {
      this.client.exec("ALTER TABLE queue_persistence ADD COLUMN elapsed REAL NOT NULL DEFAULT 0");
    } catch {}
    try {
      this.client.exec("ALTER TABLE queue_persistence ADD COLUMN duration REAL NOT NULL DEFAULT 0");
    } catch {}
    try {
      this.client.exec(
        "ALTER TABLE queue_persistence ADD COLUMN saved_at TEXT NOT NULL DEFAULT (datetime('now'))"
      );
    } catch {}

    this.client.exec(`
      CREATE TABLE IF NOT EXISTS queue_persistence (
        snapshot_id TEXT NOT NULL,
        file TEXT NOT NULL,
        position INTEGER NOT NULL,
        elapsed REAL NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        saved_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (snapshot_id, position)
      )
    `);

    this.client.exec(`
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        played INTEGER NOT NULL DEFAULT 0,
        description TEXT DEFAULT '',
        locutor_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (locutor_id) REFERENCES locutors(id) ON DELETE SET NULL
      )
    `);
    try {
      this.client.exec("ALTER TABLE playlists ADD COLUMN played INTEGER NOT NULL DEFAULT 0");
    } catch {}

    // Migrate playlists: add columns if missing
    try {
      this.client.exec("ALTER TABLE playlists ADD COLUMN description TEXT DEFAULT ''");
    } catch {}
    try {
      this.client.exec("ALTER TABLE playlists ADD COLUMN locutor_id TEXT");
    } catch {}

    this.client.exec(`
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
        script TEXT DEFAULT '',
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
      )
    `);
    try {
      this.client.exec("ALTER TABLE playlist_tracks ADD COLUMN script TEXT DEFAULT ''");
    } catch {}

    this.client.exec(`
      CREATE TABLE IF NOT EXISTS locutors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        voice TEXT NOT NULL,
        personality TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.client.exec(`
      CREATE TABLE IF NOT EXISTS locutor_schedules (
        id TEXT PRIMARY KEY,
        locutor_id TEXT NOT NULL,
        type TEXT NOT NULL,
        day_of_week INTEGER,
        start_hour TEXT NOT NULL,
        duration INTEGER NOT NULL DEFAULT 60,
        FOREIGN KEY (locutor_id) REFERENCES locutors(id) ON DELETE CASCADE
      )
    `);

    // Listener API play history (/api/live/history)
    this.client.exec(`
      CREATE TABLE IF NOT EXISTS play_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_key TEXT NOT NULL,
        file TEXT,
        title TEXT NOT NULL,
        artist TEXT DEFAULT '',
        album TEXT DEFAULT '',
        duration REAL NOT NULL DEFAULT 0,
        played_at INTEGER NOT NULL
      )
    `);
    this.client.exec(
      "CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at)"
    );
    this.client.exec(
      "CREATE INDEX IF NOT EXISTS idx_play_history_track_key ON play_history(track_key)"
    );

    // Listener song requests (/api/live/requests, /api/studio/requests)
    this.client.exec(`
      CREATE TABLE IF NOT EXISTS song_requests (
        id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL,
        file TEXT NOT NULL,
        track_key TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT DEFAULT '',
        name TEXT,
        message TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        ip_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        queued_at INTEGER,
        played_at INTEGER
      )
    `);
    this.client.exec(
      "CREATE INDEX IF NOT EXISTS idx_song_requests_status ON song_requests(status, created_at)"
    );
    this.client.exec(
      "CREATE INDEX IF NOT EXISTS idx_song_requests_ip ON song_requests(ip_hash, created_at)"
    );

    // Hearts (/api/live/hearts): PK dedupes one heart per IP hash per track key
    this.client.exec(`
      CREATE TABLE IF NOT EXISTS track_hearts (
        track_key TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (track_key, ip_hash)
      )
    `);

    // Studio reach chart (5-minute listener buckets)
    this.client.exec(`
      CREATE TABLE IF NOT EXISTS listener_samples (
        t INTEGER PRIMARY KEY,
        n INTEGER NOT NULL DEFAULT 0
      )
    `);
  }
}
