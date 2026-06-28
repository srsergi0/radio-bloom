import { and, desc, eq, sql } from "drizzle-orm";
import { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";
import { Playlist, PlaylistTrack } from "../../domain/types";

export class PlaylistRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public create(name: string): Playlist {
    const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    this.db.drizzle.insert(schema.playlists).values({ id, name, createdAt: now, updatedAt: now }).run();
    return { id, name, tracks: [], createdAt: now, updatedAt: now };
  }

  public list(): Playlist[] {
    const rows = this.db.drizzle.select().from(schema.playlists).orderBy(desc(schema.playlists.updatedAt)).all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      tracks: [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  public get(id: string): Playlist | null {
    const row = this.db.drizzle.select().from(schema.playlists).where(eq(schema.playlists.id, id)).get();
    if (!row) return null;

    const tracks = this.db.drizzle
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
        type: t.type as any,
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

  public updateName(id: string, name: string): boolean {
    const exists = this.db.drizzle
      .select({ id: schema.playlists.id })
      .from(schema.playlists)
      .where(eq(schema.playlists.id, id))
      .get();
    if (!exists) return false;

    this.db.drizzle.update(schema.playlists)
      .set({ name, updatedAt: sql`datetime('now')` })
      .where(eq(schema.playlists.id, id))
      .run();
    return true;
  }

  public delete(id: string): boolean {
    this.db.drizzle.transaction((tx) => {
      tx.delete(schema.playlistTracks).where(eq(schema.playlistTracks.playlistId, id)).run();
      tx.delete(schema.playlists).where(eq(schema.playlists.id, id)).run();
    });
    return true;
  }

  public addTrack(
    playlistId: string,
    track: {
      type: "song" | "interludio";
      file?: string;
      title: string;
      artist?: string;
      duration: number;
      spotifyUrl?: string;
    }
  ): PlaylistTrack | null {
    const exists = this.db.drizzle
      .select({ id: schema.playlists.id })
      .from(schema.playlists)
      .where(eq(schema.playlists.id, playlistId))
      .get();
    if (!exists) return null;

    const id = `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const maxPosRow = this.db.drizzle
      .select({ next: sql<number>`COALESCE(MAX(pos), -1) + 1` })
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, playlistId))
      .get();
    const nextPos = maxPosRow ? maxPosRow.next : 0;
    const now = new Date().toISOString();

    this.db.drizzle.transaction((tx) => {
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
      type: track.type,
      file: track.file,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      spotifyUrl: track.spotifyUrl,
      addedAt: now,
    };
  }

  public removeTrack(playlistId: string, trackId: string): boolean {
    const exists = this.db.drizzle
      .select({ id: schema.playlistTracks.id })
      .from(schema.playlistTracks)
      .where(
        and(eq(schema.playlistTracks.id, trackId), eq(schema.playlistTracks.playlistId, playlistId))
      )
      .get();
    if (!exists) return false;

    this.db.drizzle.transaction((tx) => {
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

  public reorderTracks(playlistId: string, trackIds: string[]): boolean {
    this.db.drizzle.transaction((tx) => {
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
}
