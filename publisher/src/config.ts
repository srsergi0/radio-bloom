import { loadConfig as dbLoadConfig, saveConfig as dbSaveConfig, updateConfig as dbUpdateConfig } from "./db";
import type { SystemConfig } from "./types";

export function loadConfig(): SystemConfig {
  return dbLoadConfig();
}

export function saveConfig(config: SystemConfig): void {
  dbSaveConfig(config);
}

export function updateConfig(updates: Partial<SystemConfig>): SystemConfig {
  return dbUpdateConfig(updates);
}
