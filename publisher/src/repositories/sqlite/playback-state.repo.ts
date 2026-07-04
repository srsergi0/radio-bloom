import { eq } from "drizzle-orm";
import type { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";

export interface QueueSnapshot {
  snapshotId: string;
  files: string[];
  count: number;
  currentElapsed: number;
  currentDuration: number;
}

export class PlaybackStateRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public hasSnapshot(snapshotId: string): boolean {
    const row = this.db.drizzle
      .select({ sid: schema.queuePersistence.snapshotId })
      .from(schema.queuePersistence)
      .where(eq(schema.queuePersistence.snapshotId, snapshotId))
      .limit(1)
      .get();
    return !!row;
  }

  public saveSnapshot(
    snapshotId: string,
    files: string[],
    currentElapsed: number = 0,
    currentDuration: number = 0
  ): void {
    this.db.client.exec("BEGIN TRANSACTION");
    try {
      this.db.client.exec("DELETE FROM queue_persistence");

      if (files.length > 0) {
        const stmt = this.db.client.prepare(
          `INSERT INTO queue_persistence (snapshot_id, file, position, elapsed, duration, saved_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`
        );

        for (let i = 0; i < files.length; i++) {
          stmt.run(
            snapshotId,
            files[i],
            i,
            i === 0 ? currentElapsed : 0,
            i === 0 ? currentDuration : 0
          );
        }
      }

      this.db.client.exec("COMMIT");
    } catch (err) {
      this.db.client.exec("ROLLBACK");
      throw err;
    }
  }

  public updateElapsed(elapsed: number): void {
    this.db.client
      .prepare(
        "UPDATE queue_persistence SET elapsed = ?, saved_at = datetime('now') WHERE position = 0"
      )
      .run(elapsed);
  }

  public getQueueSnapshot(): QueueSnapshot | null {
    const rows = this.db.drizzle
      .select()
      .from(schema.queuePersistence)
      .orderBy(schema.queuePersistence.position)
      .all();

    if (rows.length === 0) return null;

    return {
      snapshotId: rows[0].snapshotId,
      files: rows.map((r: any) => r.file),
      count: rows.length,
      currentElapsed: rows[0].elapsed,
      currentDuration: rows[0].duration,
    };
  }

  public clear(): void {
    this.db.drizzle.delete(schema.queuePersistence).run();
  }
}
