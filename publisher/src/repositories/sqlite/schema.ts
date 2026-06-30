import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const libraryTracks = sqliteTable("library_tracks", {
  id: text("id").primaryKey(),
  file: text("file").notNull().unique(),
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

export const locutors = sqliteTable("locutors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  voice: text("voice").notNull(),
  personality: text("personality").notNull(),
  isActive: integer("is_active").notNull().default(1),
  isDefault: integer("is_default").notNull().default(0),
});

export const locutorSchedules = sqliteTable("locutor_schedules", {
  id: text("id").primaryKey(),
  locutorId: text("locutor_id")
    .notNull()
    .references(() => locutors.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'daily' | 'weekly'
  dayOfWeek: integer("day_of_week"), // 0 = Sunday, 1 = Monday ... 6 = Saturday, null if daily
  startHour: text("start_hour").notNull(), // "HH:MM"
  duration: integer("duration").notNull().default(60), // in minutes
});
