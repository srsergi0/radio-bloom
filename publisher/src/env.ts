import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve default paths relative to source files
const defaultDataDir = resolve(__dirname, "../data");
const defaultMusicDir = resolve(__dirname, "../../music");

const isLocal = existsSync(defaultDataDir);

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = isLocal ? defaultDataDir : "/app/data";
}

if (!process.env.MUSIC_DIR) {
  process.env.MUSIC_DIR = isLocal ? defaultMusicDir : "/app/music";
}

if (!process.env.MUSIC_MOUNT) {
  process.env.MUSIC_MOUNT = process.env.MUSIC_DIR;
}

// Default to localhost when running outside Docker
if (!process.env.LIQUIDSOAP_HOST) {
  process.env.LIQUIDSOAP_HOST = isLocal ? "localhost" : "liquidsoap";
}

if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = isLocal ? "redis://localhost:6379/0" : "redis://redis:6379/0";
}
