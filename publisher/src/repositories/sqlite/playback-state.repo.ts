import { eq } from "drizzle-orm";
import type { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";

export interface PlaybackState {
  id: string;
  file: string;
  title: string;
  artist: string;
  elapsed: number;
  duration: number;
  savedAt: string;
}

export class PlaybackStateRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public save(state: Omit<PlaybackState, "id" | "savedAt">): void {
    this.db.drizzle
      .insert(schema.playbackState)
      .values({
        id: "current",
        file: state.file,
        title: state.title,
        artist: state.artist,
        elapsed: state.elapsed,
        duration: state.duration,
        savedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: schema.playbackState.id,
        set: {
          file: state.file,
          title: state.title,
          artist: state.artist,
          elapsed: state.elapsed,
          duration: state.duration,
          savedAt: new Date().toISOString(),
        },
      })
      .run();
  }

  public get(): PlaybackState | null {
    const row = this.db.drizzle
      .select()
      .from(schema.playbackState)
      .where(eq(schema.playbackState.id, "current"))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      file: row.file,
      title: row.title,
      artist: row.artist,
      elapsed: row.elapsed,
      duration: row.duration,
      savedAt: row.savedAt,
    };
  }

  public clear(): void {
    this.db.drizzle
      .delete(schema.playbackState)
      .where(eq(schema.playbackState.id, "current"))
      .run();
  }
}
