import { resolve } from "node:path";
import { DatabaseConnection } from "../infrastructure/database";
import { LibraryRepository } from "../repositories/sqlite/library.repo";
import { PlaylistRepository } from "../repositories/sqlite/playlist.repo";

const DATA_DIR = process.env.DATA_DIR || resolve(import.meta.dir, "..", "..", "data");

const [, , playlistId, ...trackIds] = process.argv;

if (!playlistId || trackIds.length === 0) {
  console.error(
    "Uso: bun run src/scripts/add-to-playlist.ts <playlistId> <trackId1> [trackId2] ..."
  );
  process.exit(1);
}

const db = new DatabaseConnection(resolve(DATA_DIR, "radio.db"));
const playlistRepo = new PlaylistRepository(db);
const libraryRepo = new LibraryRepository(db);

const playlist = playlistRepo.get(playlistId);
if (!playlist) {
  console.error(`Playlist "${playlistId}" no encontrada`);
  process.exit(1);
}

const results: { id: string; title: string; status: string }[] = [];

for (const id of trackIds) {
  const track = libraryRepo.getTrackById(id);
  if (!track) {
    results.push({ id, title: "(unknown)", status: "no encontrado en biblioteca" });
    continue;
  }

  const added = playlistRepo.addTrack(playlistId, {
    type: track.type as "song" | "interludio",
    file: track.file,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    spotifyUrl: track.spotifyUrl,
  });

  results.push({
    id: track.id,
    title: track.title,
    status: added ? "añadida" : "error",
  });
}

console.log(JSON.stringify({ playlist: playlist.name, results }, null, 2));
