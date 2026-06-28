import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../repositories/sqlite/schema";

export class DatabaseConnection {
  public readonly client: Database;
  public readonly drizzle: ReturnType<typeof drizzle<typeof schema>>;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.client = new Database(dbPath);
    this.client.exec("PRAGMA journal_mode = DELETE");
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
        spotify_url TEXT DEFAULT ''
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

    this.client.exec(`
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

    this.client.exec(`
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

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
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
      )
    `);
  }
}
