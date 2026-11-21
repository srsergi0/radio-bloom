import { and, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";

const t = schema.trackHearts;

export class HeartsRepository {
  constructor(private readonly db: DatabaseConnection) {}

  /** Adds a heart; returns false if this IP hash already hearted the key (PK dedupe). */
  public add(trackKey: string, ipHash: string, now = Date.now()): boolean {
    const res: any = this.db.drizzle
      .insert(t)
      .values({ trackKey, ipHash, createdAt: now })
      .onConflictDoNothing()
      .run();
    return Number(res?.changes ?? 0) > 0;
  }

  public count(trackKey: string): number {
    const row = this.db.drizzle
      .select({ count: sql`count(*)` })
      .from(t)
      .where(eq(t.trackKey, trackKey))
      .get();
    return row ? Number(row.count) : 0;
  }

  public counts(trackKeys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (trackKeys.length === 0) return out;
    const rows = this.db.drizzle
      .select({ key: t.trackKey, count: sql`count(*)` })
      .from(t)
      .where(inArray(t.trackKey, trackKeys))
      .groupBy(t.trackKey)
      .all();
    for (const r of rows) out.set(r.key, Number(r.count));
    return out;
  }

  public remove(trackKey: string, ipHash: string): void {
    this.db.drizzle
      .delete(t)
      .where(and(eq(t.trackKey, trackKey), eq(t.ipHash, ipHash)))
      .run();
  }
}
