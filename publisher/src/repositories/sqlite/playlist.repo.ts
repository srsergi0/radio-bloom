import { and, desc, eq, or, sql } from "drizzle-orm";
import type { Playlist, PlaylistTrack } from "../../domain/types";
import type { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";

export class PlaylistRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public create(
    name: string,
    options?: { description?: string; locutorId?: string }
  ): Playlist {
    const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    this.db.drizzle
      .insert(schema.playlists)
      .values({
        id,
        name,
        played: 0,
        description: options?.description || "",
        locutorId: options?.locutorId || null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return {
      id,
      name,
      played: false,
      description: options?.description,
      locutorId: options?.locutorId,
      tracks: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  public list(): Playlist[] {
    const rows = this.db.drizzle
      .select()
      .from(schema.playlists)
      .orderBy(desc(schema.playlists.updatedAt))
      .all();

    // Fetch all tracks in one query and group by playlistId
    const allTracks = this.db.drizzle
      .select()
      .from(schema.playlistTracks)
      .orderBy(schema.playlistTracks.pos)
      .all();

    const tracksByPlaylist = new Map<string, typeof allTracks>();
    for (const t of allTracks) {
      const arr = tracksByPlaylist.get(t.playlistId) || [];
      arr.push(t);
      tracksByPlaylist.set(t.playlistId, arr);
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      played: r.played === 1,
      description: r.description || undefined,
      locutorId: r.locutorId || undefined,
      tracks: (tracksByPlaylist.get(r.id) || []).map((t) => ({
        id: t.id,
        playlistId: t.playlistId,
        pos: t.pos,
        type: t.type as any,
        file: t.file || undefined,
        title: t.title,
        artist: t.artist || undefined,
        duration: t.duration,
        spotifyUrl: t.spotifyUrl || undefined,
        script: t.script || undefined,
        addedAt: t.addedAt,
      })),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  public get(id: string): Playlist | null {
    const row = this.db.drizzle
      .select()
      .from(schema.playlists)
      .where(eq(schema.playlists.id, id))
      .get();
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
      played: row.played === 1,
      description: row.description || undefined,
      locutorId: row.locutorId || undefined,
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
        script: t.script || undefined,
        addedAt: t.addedAt,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public update(id: string, updates: { name?: string; played?: boolean }): boolean {
    const exists = this.db.drizzle
      .select({ id: schema.playlists.id })
      .from(schema.playlists)
      .where(eq(schema.playlists.id, id))
      .get();
    if (!exists) return false;

    const valuesToSet: Record<string, any> = {
      updatedAt: sql`datetime('now')`,
    };
    if (updates.name !== undefined) {
      valuesToSet.name = updates.name;
    }
    if (updates.played !== undefined) {
      valuesToSet.played = updates.played ? 1 : 0;
    }

    this.db.drizzle
      .update(schema.playlists)
      .set(valuesToSet)
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
      script?: string;
    },
    position?: number
  ): PlaylistTrack | null {
    const exists = this.db.drizzle
      .select({ id: schema.playlists.id })
      .from(schema.playlists)
      .where(eq(schema.playlists.id, playlistId))
      .get();
    if (!exists) return null;

    const id = `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    if (position !== undefined) {
      const existingTracks = this.db.drizzle
        .select({ id: schema.playlistTracks.id, pos: schema.playlistTracks.pos })
        .from(schema.playlistTracks)
        .where(eq(schema.playlistTracks.playlistId, playlistId))
        .orderBy(schema.playlistTracks.pos)
        .all();

      const safePos = Math.max(0, Math.min(position, existingTracks.length));

      this.db.drizzle.transaction((tx) => {
        for (let i = safePos; i < existingTracks.length; i++) {
          tx.update(schema.playlistTracks)
            .set({ pos: i + 1 })
            .where(eq(schema.playlistTracks.id, existingTracks[i].id))
            .run();
        }
        tx.insert(schema.playlistTracks)
          .values({
            id,
            playlistId,
            pos: safePos,
            type: track.type,
            file: track.file || null,
            title: track.title,
            artist: track.artist || "",
            duration: track.duration,
            spotifyUrl: track.spotifyUrl || "",
            script: track.script || "",
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
        pos: safePos,
        type: track.type,
        file: track.file,
        title: track.title,
        artist: track.artist,
        duration: track.duration,
        spotifyUrl: track.spotifyUrl,
        script: track.script,
        addedAt: now,
      };
    }

    const maxPosRow = this.db.drizzle
      .select({ next: sql`COALESCE(MAX(pos), -1) + 1` })
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, playlistId))
      .get();
    const nextPos = maxPosRow ? maxPosRow.next : 0;

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
          script: track.script || "",
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
      script: track.script,
      addedAt: now,
    };
  }

  public updateTrack(
    playlistId: string,
    trackId: string,
    updates: {
      type?: "song" | "interludio";
      title?: string;
      artist?: string;
      duration?: number;
      spotifyUrl?: string;
      script?: string;
    }
  ): PlaylistTrack | null {
    const existing = this.db.drizzle
      .select()
      .from(schema.playlistTracks)
      .where(
        and(eq(schema.playlistTracks.id, trackId), eq(schema.playlistTracks.playlistId, playlistId))
      )
      .get();
    if (!existing) return null;

    const setValues: Record<string, any> = {};
    if (updates.type !== undefined) setValues.type = updates.type;
    if (updates.title !== undefined) setValues.title = updates.title;
    if (updates.artist !== undefined) setValues.artist = updates.artist;
    if (updates.duration !== undefined) setValues.duration = updates.duration;
    if (updates.spotifyUrl !== undefined) setValues.spotifyUrl = updates.spotifyUrl;
    if (updates.script !== undefined) setValues.script = updates.script;

    if (Object.keys(setValues).length === 0) return null;

    this.db.drizzle.transaction((tx) => {
      tx.update(schema.playlistTracks)
        .set(setValues)
        .where(eq(schema.playlistTracks.id, trackId))
        .run();
      tx.update(schema.playlists)
        .set({ updatedAt: sql`datetime('now')` })
        .where(eq(schema.playlists.id, playlistId))
        .run();
    });

    const updated = this.db.drizzle
      .select()
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.id, trackId))
      .get();

    if (!updated) return null;

    return {
      id: updated.id,
      playlistId: updated.playlistId,
      pos: updated.pos,
      type: updated.type as "song" | "interludio",
      file: updated.file || undefined,
      title: updated.title,
      artist: updated.artist || undefined,
      duration: updated.duration,
      spotifyUrl: updated.spotifyUrl || undefined,
      script: updated.script || undefined,
      addedAt: updated.addedAt,
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
          and(
            eq(schema.playlistTracks.id, trackId),
            eq(schema.playlistTracks.playlistId, playlistId)
          )
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

  public findByLocutorAndTime(
    locutorId: string,
    dayOfWeek: number,
    startHour: string
  ): Playlist | null {
    const row = this.db.drizzle
      .select()
      .from(schema.playlists)
      .where(
        and(
          eq(schema.playlists.locutorId, locutorId),
          or(
            sql`${schema.playlists.locutorId} IS NULL`,
            eq(schema.playlists.locutorId, locutorId)
          )
        )
      )
      .orderBy(desc(schema.playlists.updatedAt))
      .get();
    if (!row) return null;

    const tracks = this.db.drizzle
      .select()
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, row.id))
      .orderBy(schema.playlistTracks.pos)
      .all();

    return {
      id: row.id,
      name: row.name,
      played: row.played === 1,
      description: row.description || undefined,
      locutorId: row.locutorId || undefined,
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
        script: t.script || undefined,
        addedAt: t.addedAt,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public findActivePlaylistForLocutor(locutorId: string): Playlist | null {
    const row = this.db.drizzle
      .select()
      .from(schema.playlists)
      .where(and(
        eq(schema.playlists.locutorId, locutorId),
        eq(schema.playlists.played, 0)
      ))
      .orderBy(desc(schema.playlists.updatedAt))
      .get();
    if (!row) return null;

    const tracks = this.db.drizzle
      .select()
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, row.id))
      .orderBy(schema.playlistTracks.pos)
      .all();

    return {
      id: row.id,
      name: row.name,
      played: row.played === 1,
      description: row.description || undefined,
      locutorId: row.locutorId || undefined,
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
        script: t.script || undefined,
        addedAt: t.addedAt,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public updateLocutorAndDescription(
    id: string,
    updates: { locutorId?: string; description?: string }
  ): boolean {
    const exists = this.db.drizzle
      .select({ id: schema.playlists.id })
      .from(schema.playlists)
      .where(eq(schema.playlists.id, id))
      .get();
    if (!exists) return false;

    const setValues: Record<string, any> = { updatedAt: sql`datetime('now')` };
    if (updates.locutorId !== undefined) setValues.locutorId = updates.locutorId;
    if (updates.description !== undefined) setValues.description = updates.description;

    this.db.drizzle
      .update(schema.playlists)
      .set(setValues)
      .where(eq(schema.playlists.id, id))
      .run();
    return true;
  }

  public findScriptByFile(file: string): string | null {
    const row = this.db.drizzle
      .select({ script: schema.playlistTracks.script })
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.file, file))
      .get();
    return row?.script || null;
  }
}
