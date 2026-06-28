import type { SystemConfig } from "../../domain/types";
import type { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";

const DEFAULT_CONFIG: SystemConfig = {
  streamBitrate: 320,
  streamSampleRate: 44100,
  crossfadeDuration: 3,
  playlistReloadSeconds: 30,
};

export class ConfigRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public load(): SystemConfig {
    const config = { ...DEFAULT_CONFIG };
    const rows = this.db.drizzle.select().from(schema.config).all();
    for (const row of rows) {
      const num = Number(row.value);
      (config as any)[row.key] = Number.isNaN(num) ? row.value : num;
    }
    return config;
  }

  public save(config: SystemConfig): void {
    this.db.drizzle.transaction((tx) => {
      for (const [key, value] of Object.entries(config)) {
        tx.insert(schema.config)
          .values({ key, value: String(value) })
          .onConflictDoUpdate({ target: schema.config.key, set: { value: String(value) } })
          .run();
      }
    });
  }
}
