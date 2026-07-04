import { resolve } from "node:path";
import { DatabaseConnection } from "../infrastructure/database";
import { PlaylistRepository } from "../repositories/sqlite/playlist.repo";

const DATA_DIR = process.env.DATA_DIR || resolve(import.meta.dir, "..", "..", "data");
const name = process.argv[2];

if (!name) {
  console.error('Uso: bun run src/scripts/create-playlist.ts "Nombre de la playlist"');
  process.exit(1);
}

const db = new DatabaseConnection(resolve(DATA_DIR, "radio.db"));
const playlistRepo = new PlaylistRepository(db);
const playlist = playlistRepo.create(name);
console.log(JSON.stringify(playlist, null, 2));
