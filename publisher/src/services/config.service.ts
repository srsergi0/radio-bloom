import { ConfigRepository } from "../repositories/sqlite/config.repo";
import { SystemConfig } from "../domain/types";

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
