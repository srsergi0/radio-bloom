console.log = console.error;

import "./env";
import { resolve } from "node:path";
import { AudioMetadataClient } from "./infrastructure/audio-metadata.client";
import { BuncasterClient } from "./infrastructure/buncaster.client";
import { DatabaseConnection } from "./infrastructure/database";
import { LibraryRepository } from "./repositories/sqlite/library.repo";
import { PlaylistRepository } from "./repositories/sqlite/playlist.repo";
import { BuncasterService } from "./services/buncaster.service";
import { createLibraryService } from "./services/library.service";
import { McpService } from "./services/mcp.service";
import { TorrentService } from "./services/torrent.service";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MUSIC_DIR = process.env.MUSIC_DIR || "/app/music";
const MUSIC_MOUNT = process.env.MUSIC_MOUNT || "/app/music";

const BUNCASTER_HOST = process.env.BUNCASTER_HOST || "buncaster";
const BUNCASTER_PORT = parseInt(process.env.BUNCASTER_PORT || "4321", 10);
const BUNCASTER_ADMIN_USER = process.env.BUNCASTER_ADMIN_USER || "admin";
const BUNCASTER_ADMIN_PASSWORD = process.env.BUNCASTER_ADMIN_PASSWORD || "radiobloom";

const dbPath = resolve(DATA_DIR, "radio.db");
const dbConnection = new DatabaseConnection(dbPath);

const buncasterClient = new BuncasterClient(
  BUNCASTER_HOST,
  BUNCASTER_PORT,
  BUNCASTER_ADMIN_USER,
  BUNCASTER_ADMIN_PASSWORD
);
const audioMetadataClient = new AudioMetadataClient();

const libraryRepo = new LibraryRepository(dbConnection);
const playlistRepo = new PlaylistRepository(dbConnection);

const buncasterService = new BuncasterService(buncasterClient, audioMetadataClient, MUSIC_MOUNT);
const libraryService = createLibraryService({
  libraryRepo,
  audioMetadataClient,
  musicDir: MUSIC_DIR,
  onDeleteCallback: async () => {
    await buncasterService.queueClear(false);
  },
});

const torrentService = new TorrentService();
const mcpService = new McpService(
  libraryRepo,
  playlistRepo,
  libraryService,
  buncasterService,
  torrentService
);

libraryService.init().catch((err) => console.error("[mcp] libraryService:", err));

mcpService.startStdioServer().catch((err) => {
  console.error("[mcp] Fatal:", err);
  process.exit(1);
});
