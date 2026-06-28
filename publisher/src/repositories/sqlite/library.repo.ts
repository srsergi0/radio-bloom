import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";
import { DownloadJob, LibraryStats, Track } from "../../domain/types";

function fileToId(file: string): string {
  let hash = 0;
  for (let i = 0; i < file.length; i++) {
    hash = (hash << 5) - hash + file.charCodeAt(i);
    hash |= 0;
  }
  return `lib_${Math.abs(hash).toString(36)}`;
}

export class LibraryRepository {
  constructor(private readonly db: DatabaseConnection) {}

  // --- DOWNLOAD JOBS ---

  public createDownload(url: string): DownloadJob {
    const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    this.db.drizzle.insert(schema.downloads).values({ id, url, status: "queued", startedAt: now }).run();
    return { id, url, status: "queued", startedAt: now };
  }

  public getNextQueuedDownload(): DownloadJob | null {
    const row = this.db.drizzle
      .select()
      .from(schema.downloads)
      .where(eq(schema.downloads.status, "queued"))
      .orderBy(schema.downloads.startedAt)
      .limit(1)
      .get();
    if (!row) return null;
    return this.mapDownloadRow(row);
  }

  public updateDownload(id: string, updates: Partial<DownloadJob & { result: Track }>): void {
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
      this.db.drizzle.update(schema.downloads).set(setClause).where(eq(schema.downloads.id, id)).run();
    }
  }

  public getDownload(id: string): DownloadJob | null {
    const row = this.db.drizzle.select().from(schema.downloads).where(eq(schema.downloads.id, id)).get();
    if (!row) return null;
    return this.mapDownloadRow(row);
  }

  public getAllDownloads(): DownloadJob[] {
    const rows = this.db.drizzle.select().from(schema.downloads).orderBy(desc(schema.downloads.startedAt)).all();
    return rows.map((r) => this.mapDownloadRow(r));
  }

  public clearDownloads(): void {
    this.db.drizzle.delete(schema.downloads).run();
  }

  private mapDownloadRow(row: any): DownloadJob {
    const job: DownloadJob = {
      id: row.id,
      url: row.url,
      status: row.status as any,
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

  // --- LIBRARY TRACKS ---

  public getTrackByUrl(spotifyUrl: string): Track | null {
    const row = this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.spotifyUrl, spotifyUrl))
      .get();
    if (!row) return null;
    return this.mapTrackRow(row);
  }

  public getTrack(file: string): Track | null {
    const row = this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.file, file))
      .get();
    if (!row) return null;
    return this.mapTrackRow(row);
  }

  public getAllTracks(type?: "song" | "interludio"): Track[] {
    let query = this.db.drizzle.select().from(schema.libraryTracks).$dynamic();
    if (type) {
      query = query.where(eq(schema.libraryTracks.type, type));
    }
    const rows = query.orderBy(schema.libraryTracks.file).all();
    return rows.map((r) => this.mapTrackRow(r));
  }

  public getTracksPage(type: "song" | "interludio", limit: number, offset: number): Track[] {
    const rows = this.db.drizzle
      .select()
      .from(schema.libraryTracks)
      .where(eq(schema.libraryTracks.type, type))
      .orderBy(schema.libraryTracks.file)
      .limit(limit)
      .offset(offset)
      .all();
    return rows.map((r) => this.mapTrackRow(r));
  }

  public countTracks(type: "song" | "interludio"): number {
    const row = this.db.drizzle
      .select({ count: sql<number>`count(*)` })
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
  }): void {
    this.db.drizzle.insert(schema.libraryTracks)
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

  public removeTrack(file: string): void {
    this.db.drizzle.delete(schema.libraryTracks).where(eq(schema.libraryTracks.file, file)).run();
  }

  public search(query: string, limit = 50, offset = 0): { items: Track[]; total: number } {
    const q = `%${query}%`;
    const totalRow = this.db.drizzle
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

    const rows = this.db.drizzle
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
      items: rows.map((r) => this.mapTrackRow(r)),
    };
  }

  public getStats(): LibraryStats {
    const stats = this.db.drizzle
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

  private mapTrackRow(row: any): Track {
    return {
      id: fileToId(row.file),
      type: row.type as any,
      file: row.file,
      title: row.title,
      artist: row.artist || undefined,
      album: row.album || undefined,
      duration: row.duration,
      spotifyUrl: row.spotifyUrl || undefined,
      addedAt: row.addedAt,
    };
  }
}
