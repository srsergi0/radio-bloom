import { asc, gte, lt } from "drizzle-orm";
import type { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";

const t = schema.listenerSamples;

export class ListenerSamplesRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public upsert(bucket: number, n: number): void {
    this.db.drizzle
      .insert(t)
      .values({ t: bucket, n })
      .onConflictDoUpdate({ target: t.t, set: { n } })
      .run();
  }

  /** Oldest first. */
  public since(fromMs: number): { t: number; n: number }[] {
    return this.db.drizzle
      .select()
      .from(t)
      .where(gte(t.t, fromMs))
      .orderBy(asc(t.t))
      .all()
      .map((r: any) => ({ t: Number(r.t), n: Number(r.n) }));
  }

  public pruneBefore(ms: number): void {
    this.db.drizzle.delete(t).where(lt(t.t, ms)).run();
  }
}
