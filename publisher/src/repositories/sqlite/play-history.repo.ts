import { desc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";

export interface PlayHistoryRow {
  id: number;
  trackKey: string;
  file: string | null;
  title: string;
  artist: string;
  album: string;
  duration: number;
  playedAt: number;
}

export class PlayHistoryRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly maxRows = 500
  ) {}

  public insert(entry: Omit<PlayHistoryRow, "id">): void {
    this.db.drizzle
      .insert(schema.playHistory)
      .values({
        trackKey: entry.trackKey,
        file: entry.file,
        title: entry.title,
        artist: entry.artist,
        album: entry.album,
        duration: entry.duration,
        playedAt: entry.playedAt,
      })
      .run();
    this.prune();
  }

  /** Newest first. */
  public list(limit: number): PlayHistoryRow[] {
    return this.db.drizzle
      .select()
      .from(schema.playHistory)
      .orderBy(desc(schema.playHistory.playedAt), desc(schema.playHistory.id))
      .limit(limit)
      .all()
      .map((r: any) => this.mapRow(r));
  }

  public latest(): PlayHistoryRow | null {
    return this.list(1)[0] ?? null;
  }

  public findFileByKey(trackKey: string): string | null {
    const row = this.db.drizzle
      .select()
      .from(schema.playHistory)
      .where(eq(schema.playHistory.trackKey, trackKey))
      .limit(1)
      .get();
    return row?.file || null;
  }

  /** Newest playedAt for each key (keys never played are absent). */
  public lastPlayedAtByKeys(trackKeys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (trackKeys.length === 0) return out;
    const rows = this.db.drizzle
      .select({ key: schema.playHistory.trackKey, last: sql`max(${schema.playHistory.playedAt})` })
      .from(schema.playHistory)
      .where(inArray(schema.playHistory.trackKey, trackKeys))
      .groupBy(schema.playHistory.trackKey)
      .all();
    for (const r of rows) out.set(r.key, Number(r.last));
    return out;
  }

  public lastPlayedAt(trackKey: string): number | null {
    return this.lastPlayedAtByKeys([trackKey]).get(trackKey) ?? null;
  }

  private prune(): void {
    this.db.drizzle
      .delete(schema.playHistory)
      .where(
        sql`${schema.playHistory.id} NOT IN (SELECT id FROM play_history ORDER BY played_at DESC, id DESC LIMIT ${this.maxRows})`
      )
      .run();
  }

  private mapRow(r: any): PlayHistoryRow {
    return {
      id: r.id,
      trackKey: r.trackKey,
      file: r.file ?? null,
      title: r.title,
      artist: r.artist ?? "",
      album: r.album ?? "",
      duration: r.duration ?? 0,
      playedAt: r.playedAt,
    };
  }
}
