console.log = console.error;

import "./env";
import { resolve } from "node:path";
import { AudioMetadataClient } from "./infrastructure/audio-metadata.client";
import { DatabaseConnection } from "./infrastructure/database";
import { TelnetClient } from "./infrastructure/telnet.client";
import { LibraryRepository } from "./repositories/sqlite/library.repo";
import { PlaylistRepository } from "./repositories/sqlite/playlist.repo";
import { LibraryService } from "./services/library.service";
import { LiquidsoapService } from "./services/liquidsoap.service";
import { McpService } from "./services/mcp.service";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MUSIC_DIR = process.env.MUSIC_DIR || "/app/music";
const MUSIC_MOUNT = process.env.MUSIC_MOUNT || "/app/music";

const LIQUIDSOAP_HOST = process.env.LIQUIDSOAP_HOST || "liquidsoap";
const LIQUIDSOAP_TELNET_PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || "1234", 10);

const dbPath = resolve(DATA_DIR, "radio.db");
const dbConnection = new DatabaseConnection(dbPath);

const telnetClient = new TelnetClient(LIQUIDSOAP_HOST, LIQUIDSOAP_TELNET_PORT);
const audioMetadataClient = new AudioMetadataClient();

const libraryRepo = new LibraryRepository(dbConnection);
const playlistRepo = new PlaylistRepository(dbConnection);

const liquidsoapService = new LiquidsoapService(telnetClient, audioMetadataClient, MUSIC_MOUNT);
const libraryService = new LibraryService(libraryRepo, audioMetadataClient, MUSIC_DIR, async () => {
  await liquidsoapService.queueClear();
});

const mcpService = new McpService(libraryRepo, playlistRepo, libraryService, liquidsoapService);

libraryService.init().catch((err) => console.error("[mcp] libraryService:", err));

mcpService.startStdioServer().catch((err) => {
  console.error("[mcp] Fatal:", err);
  process.exit(1);
});
