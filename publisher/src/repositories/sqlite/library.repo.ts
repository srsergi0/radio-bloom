import { and, eq, or, sql } from "drizzle-orm";
import type { Track } from "../../domain/types";
import type { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";

function fileToId(file: string): string {
  let hash = 0;
  for (let i = 0; i < file.length; i++) {
    hash = (hash << 5) - hash + file.charCodeAt(i);
    hash |= 0;
  }
  return `lib_${Math.abs(hash).toString(36)}`;
}

function generateId(spotifyUrl?: string): string {
  if (spotifyUrl) {
    const m = spotifyUrl.match(/\/track\/([a-zA-Z0-9]+)/);
    if (m) return m[1];
  }
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class LibraryRepository {
  constructor(private readonly db: DatabaseConnection) {}

  // --- LIBRARY TRACKS ---

  public getTrackById(id: string): Track | null {
    const row = this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.id, id))
      .get();
    return row ? this.mapTrackRow(row) : null;
  }

  public getTrackByFile(file: string): Track | null {
    const row = this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.file, file))
      .get();
    return row ? this.mapTrackRow(row) : null;
  }

  public getTracksByFiles(files: string[]): Map<string, Track> {
    if (files.length === 0) return new Map();
    const rows = this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(sql`${schema.libraryTracks.file} in ${files}`)
      .all();
    const map = new Map<string, Track>();
    for (const row of rows) {
      const track = this.mapTrackRow(row);
      map.set(track.file, track);
    }
    return map;
  }

  public getTrackByUrl(spotifyUrl: string): Track | null {
    const row = this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.spotifyUrl, spotifyUrl))
      .get();
    return row ? this.mapTrackRow(row) : null;
  }

  public getTrackByTitleAndArtist(title: string, artist: string): Track | null {
    const row = this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(
        and(
          eq(sql`lower(${schema.libraryTracks.title})`, title.toLowerCase().trim()),
          eq(sql`lower(${schema.libraryTracks.artist})`, artist.toLowerCase().trim())
        )
      )
      .get();
    return row ? this.mapTrackRow(row) : null;
  }

  public getAllTracks(type?: "song" | "interludio"): Track[] {
    let query = this.db.drizzle.select().from(schema.libraryTracks).$dynamic();
    if (type) query = query.where(eq(schema.libraryTracks.type, type));
    return query
      .orderBy(schema.libraryTracks.file)
      .all()
      .map((r) => this.mapTrackRow(r));
  }

  public getTracksPage(type: "song" | "interludio", limit: number, offset: number): Track[] {
    return this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.type, type))
      .orderBy(schema.libraryTracks.file)
      .limit(limit)
      .offset(offset)
      .all()
      .map((r) => this.mapTrackRow(r));
  }

  public countTracks(type: "song" | "interludio"): number {
    const row = this.db.drizzle
      .select({ count: sql`count(*)` })
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.type, type))
      .get();
    return row ? row.count : 0;
  }

  public upsertTrack(track: {
    file: string;
    type: "song" | "interludio";
    title: string;
    artist?: string;
    album?: string;
    duration: number;
    spotify_url?: string;
    size: number;
    mtime: string;
  }): string {
    const existingByFile = this.db.client
      .query("SELECT id FROM library_tracks WHERE file = $file")
      .get({ $file: track.file }) as { id: string } | undefined;

    let id = existingByFile?.id;
    const spotifyId = track.spotify_url ? generateId(track.spotify_url) : null;

    if (!id && spotifyId) {
      const existingById = this.db.client
        .query("SELECT id FROM library_tracks WHERE id = $id")
        .get({ $id: spotifyId }) as { id: string } | undefined;
      if (existingById) {
        id = spotifyId;
      }
    }

    const now = new Date().toISOString();

    if (id) {
      this.db.drizzle
        .update(schema.libraryTracks)
        .set({
          file: track.file,
          type: track.type,
          title: track.title,
          artist: track.artist || "",
          album: track.album || "",
          duration: track.duration,
          spotifyUrl: track.spotify_url || "",
          size: track.size,
          mtime: track.mtime,
        })
        .where(eq(schema.libraryTracks.id, id))
        .run();
    } else {
      id = spotifyId || generateId();
      this.db.drizzle
        .insert(schema.libraryTracks)
        .values({
          id,
          file: track.file,
          type: track.type,
          title: track.title,
          artist: track.artist || "",
          album: track.album || "",
          duration: track.duration,
          spotifyUrl: track.spotify_url || "",
          size: track.size,
          mtime: track.mtime,
          addedAt: now,
        })
        .run();
    }

    return id;
  }

  public updateSpotifyUrl(file: string, spotifyUrl: string): string | null {
    const spotifyId = spotifyUrl.match(/\/track\/([a-zA-Z0-9]+)/)?.[1];
    if (!spotifyId) return null;
    this.db.drizzle
      .update(schema.libraryTracks)
      .set({ spotifyUrl, id: spotifyId })
      .where(eq(schema.libraryTracks.file, file))
      .run();
    return spotifyId;
  }

  public removeTrack(file: string): void {
    this.db.drizzle.delete(schema.libraryTracks).where(eq(schema.libraryTracks.file, file)).run();
  }

  public upsertTtsInterludio(
    file: string,
    script: string,
    duration: number = 0,
    size: number = 0
  ): void {
    this.db.drizzle
      .insert(schema.libraryTracks)
      .values({
        id: `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        file,
        type: "interludio",
        title: "Interludio TTS",
        artist: "",
        duration,
        script,
        size,
        mtime: "",
      })
      .onConflictDoUpdate({
        target: schema.libraryTracks.file,
        set: { script, duration, size },
      })
      .run();
  }

  public updateLastPlayedAt(id: string): void {
    this.db.drizzle
      .update(schema.libraryTracks)
      .set({ lastPlayedAt: new Date().toISOString() })
      .where(eq(schema.libraryTracks.id, id))
      .run();
  }

  public search(query: string, limit = 50, offset = 0): { items: Track[]; total: number } {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");

    const qNorm = normalize(query);
    const words = qNorm.split(/\s+/).filter(Boolean);

    const stripForMatch = (col: any) =>
      sql`lower(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(${col},'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u'),'ñ','n'),'ü','u'),' ',''),'-',''),'.',''))`;

    const conditions = words.map((w) =>
      or(
        sql`${stripForMatch(schema.libraryTracks.title)} like ${`%${w}%`}`,
        sql`${stripForMatch(schema.libraryTracks.artist)} like ${`%${w}%`}`,
        sql`${stripForMatch(schema.libraryTracks.album)} like ${`%${w}%`}`
      )
    );

    const fullNorm = stripForMatch(schema.libraryTracks.title);
    const fullNormArtist = stripForMatch(schema.libraryTracks.artist);
    const fullNormAlbum = stripForMatch(schema.libraryTracks.album);

    const where =
      conditions.length > 0
        ? or(
            and(...conditions),
            sql`${fullNorm} like ${`%${qNorm}%`}`,
            sql`${fullNormArtist} like ${`%${qNorm}%`}`,
            sql`${fullNormAlbum} like ${`%${qNorm}%`}`
          )
        : undefined;

    const totalRow = this.db.drizzle
      .select({ count: sql`count(*)` })
      .from(schema.libraryTracks)
      .where(where)
      .get();

    const rows = this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(where)
      .orderBy(schema.libraryTracks.file)
      .limit(limit)
      .offset(offset)
      .all();

    return { total: totalRow ? totalRow.count : 0, items: rows.map((r) => this.mapTrackRow(r)) };
  }

  private mapTrackRow(row: any): Track {
    return {
      id: row.id || fileToId(row.file),
      type: row.type as any,
      file: row.file,
      title: row.title,
      artist: row.artist || undefined,
      album: row.album || undefined,
      duration: row.duration,
      spotifyUrl: row.spotifyUrl || undefined,
      addedAt: row.addedAt,
      mtime: row.mtime || undefined,
      lastPlayedAt: row.lastPlayedAt || undefined,
      script: row.script || undefined,
    };
  }
}
