import type { SystemConfig } from "../domain/types";
import type { ConfigRepository } from "../repositories/sqlite/config.repo";

export class ConfigService {
  constructor(private readonly configRepo: ConfigRepository) {}

  public get(): SystemConfig {
    return this.configRepo.load();
  }

  public update(updates: Partial<SystemConfig>): SystemConfig {
    const config = this.configRepo.load();
    Object.assign(config, updates);
    this.configRepo.save(config);
    return config;
  }
}
