import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const libraryTracks = sqliteTable("library_tracks", {
  id: text("id").primaryKey(),
  file: text("file").notNull(),
  type: text("type").notNull().default("song"),
  title: text("title").notNull(),
  artist: text("artist").default(""),
  album: text("album").default(""),
  duration: real("duration").notNull().default(0),
  addedAt: text("added_at").notNull().default(sql`(datetime('now'))`),
  size: integer("size").default(0),
  mtime: text("mtime").default(""),
  spotifyUrl: text("spotify_url").default(""),
});

export const downloads = sqliteTable("downloads", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  status: text("status").notNull().default("queued"),
  resultFile: text("result_file").default(""),
  resultTitle: text("result_title").default(""),
  resultDuration: real("result_duration").default(0),
  resultSpotifyUrl: text("result_spotify_url").default(""),
  error: text("error").default(""),
  startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
  completedAt: text("completed_at").default(""),
});

export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const playbackState = sqliteTable("playback_state", {
  id: text("id").primaryKey(),
  file: text("file").notNull().default(""),
  title: text("title").notNull().default(""),
  artist: text("artist").notNull().default(""),
  elapsed: real("elapsed").notNull().default(0),
  duration: real("duration").notNull().default(0),
  savedAt: text("saved_at").notNull().default(sql`(datetime('now'))`),
});

export const playlistTracks = sqliteTable("playlist_tracks", {
  id: text("id").primaryKey(),
  playlistId: text("playlist_id")
    .notNull()
    .references(() => playlists.id, { onDelete: "cascade" }),
  pos: integer("pos").notNull(),
  type: text("type").notNull().default("song"),
  file: text("file"),
  title: text("title").notNull(),
  artist: text("artist").default(""),
  duration: real("duration").notNull().default(0),
  spotifyUrl: text("spotify_url").default(""),
  addedAt: text("added_at").notNull().default(sql`(datetime('now'))`),
});
