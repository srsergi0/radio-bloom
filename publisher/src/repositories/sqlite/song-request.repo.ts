import { desc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../../infrastructure/database";
import type { SongRequestRow, SongRequestStatus } from "../../services/song-requests.mapper";
import * as schema from "./schema";

const t = schema.songRequests;

export class SongRequestRepository {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly maxRows = 2000
  ) {}

  public insert(row: SongRequestRow): void {
    this.db.drizzle
      .insert(t)
      .values({
        id: row.id,
        trackId: row.trackId,
        file: row.file,
        trackKey: row.trackKey,
        title: row.title,
        artist: row.artist,
        name: row.name,
        message: row.message,
        status: row.status,
        ipHash: row.ipHash,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        queuedAt: row.queuedAt,
        playedAt: row.playedAt,
      })
      .run();
    this.prune();
  }

  public get(id: string): SongRequestRow | null {
    const row = this.db.drizzle.select().from(t).where(eq(t.id, id)).get();
    return row ? this.mapRow(row) : null;
  }

  public update(
    id: string,
    patch: Partial<Pick<SongRequestRow, "status" | "queuedAt" | "playedAt">>,
    now = Date.now()
  ): void {
    this.db.drizzle
      .update(t)
      .set({ ...patch, updatedAt: now })
      .where(eq(t.id, id))
      .run();
  }

  /** Newest first. */
  public listByStatus(statuses: SongRequestStatus[], limit = 500): SongRequestRow[] {
    if (statuses.length === 0) return [];
    return this.db.drizzle
      .select()
      .from(t)
      .where(inArray(t.status, statuses))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit)
      .all()
      .map((r: any) => this.mapRow(r));
  }

  /** Newest first, every status. */
  public listRecent(limit = 200): SongRequestRow[] {
    return this.db.drizzle
      .select()
      .from(t)
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit)
      .all()
      .map((r: any) => this.mapRow(r));
  }

  public countByStatus(status: SongRequestStatus): number {
    const row = this.db.drizzle
      .select({ count: sql`count(*)` })
      .from(t)
      .where(eq(t.status, status))
      .get();
    return row ? Number(row.count) : 0;
  }

  /** createdAt of the newest request from this IP hash (any status). */
  public lastCreatedAtByIp(ipHash: string): number | null {
    const row = this.db.drizzle
      .select({ createdAt: t.createdAt })
      .from(t)
      .where(eq(t.ipHash, ipHash))
      .orderBy(desc(t.createdAt))
      .limit(1)
      .get();
    return row ? Number(row.createdAt) : null;
  }

  public deleteById(id: string): void {
    this.db.drizzle.delete(t).where(eq(t.id, id)).run();
  }

  private prune(): void {
    this.db.drizzle
      .delete(t)
      .where(
        sql`${t.id} NOT IN (SELECT id FROM song_requests ORDER BY created_at DESC LIMIT ${this.maxRows})`
      )
      .run();
  }

  private mapRow(r: any): SongRequestRow {
    return {
      id: r.id,
      trackId: r.trackId,
      file: r.file,
      trackKey: r.trackKey,
      title: r.title,
      artist: r.artist ?? "",
      name: r.name ?? null,
      message: r.message ?? null,
      status: r.status as SongRequestStatus,
      ipHash: r.ipHash,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
      queuedAt: r.queuedAt ?? null,
      playedAt: r.playedAt ?? null,
    };
  }
}
