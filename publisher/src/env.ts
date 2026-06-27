import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve default paths relative to source files
const defaultDataDir = resolve(__dirname, "../data");
const defaultMusicDir = resolve(__dirname, "../../music");

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = existsSync(defaultDataDir) ? defaultDataDir : "/app/data";
}

if (!process.env.MUSIC_DIR) {
  process.env.MUSIC_DIR = existsSync(defaultMusicDir) ? defaultMusicDir : "/app/music";
}

if (!process.env.MUSIC_MOUNT) {
  process.env.MUSIC_MOUNT = process.env.MUSIC_DIR;
}
