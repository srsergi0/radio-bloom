import "./env";
import { resolve } from "node:path";
import { createApiRouter } from "./api/router";
import { AudioMetadataClient } from "./infrastructure/audio-metadata.client";
import { BuncasterClient } from "./infrastructure/buncaster.client";
import { DatabaseConnection } from "./infrastructure/database";
import { ConfigRepository } from "./repositories/sqlite/config.repo";
import { LibraryRepository } from "./repositories/sqlite/library.repo";
import { LocutorRepository } from "./repositories/sqlite/locutor.repo";
import { PlaybackStateRepository } from "./repositories/sqlite/playback-state.repo";
import { PlaylistRepository } from "./repositories/sqlite/playlist.repo";
import { BuncasterService } from "./services/buncaster.service";
import { BuncasterQueueService } from "./services/buncaster-queue.service";
import { ConfigService } from "./services/config.service";
import { createLibraryService } from "./services/library.service";
import { LocutorService } from "./services/locutor.service";
import { OrchestratorService } from "./services/orchestrator.service";
import { QueuePersistenceService } from "./services/queue-persistence.service";
import { TorrentService } from "./services/torrent.service";
import { TtsService } from "./services/tts.service";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MUSIC_DIR = process.env.MUSIC_DIR || "/app/music";
const MUSIC_MOUNT = process.env.MUSIC_MOUNT || "/app/music";

const BUNCASTER_HOST = process.env.BUNCASTER_HOST || "buncaster";
const BUNCASTER_PORT = parseInt(process.env.BUNCASTER_PORT || "4321", 10);
const BUNCASTER_ADMIN_USER = process.env.BUNCASTER_ADMIN_USER || "admin";
const BUNCASTER_ADMIN_PASSWORD = process.env.BUNCASTER_ADMIN_PASSWORD || "radiobloom";

const DIST_DIR =
  process.env.NODE_ENV === "production"
    ? "/app/web/dist"
    : resolve(import.meta.dirname || "", "../../web/dist");

// ============================================================
// 1. Infrastructure & Connections Instantiation
// ============================================================
const dbPath = resolve(DATA_DIR, "radio.db");
const dbConnection = new DatabaseConnection(dbPath);

const buncasterClient = new BuncasterClient(
  BUNCASTER_HOST,
  BUNCASTER_PORT,
  BUNCASTER_ADMIN_USER,
  BUNCASTER_ADMIN_PASSWORD
);
const audioMetadataClient = new AudioMetadataClient();

// ============================================================
// 2. Repositories Instantiation (Data Access)
// ============================================================
const configRepo = new ConfigRepository(dbConnection);
const libraryRepo = new LibraryRepository(dbConnection);
const playlistRepo = new PlaylistRepository(dbConnection);
const playbackStateRepo = new PlaybackStateRepository(dbConnection);
const locutorRepo = new LocutorRepository(dbConnection);

// ============================================================
// 3. Services & Use Cases Instantiation
// ============================================================
const configService = new ConfigService(configRepo);
const buncasterService = new BuncasterService(
  buncasterClient,
  audioMetadataClient,
  MUSIC_MOUNT,
  libraryRepo,
  playlistRepo
);
const locutorService = new LocutorService(locutorRepo);

const libraryService = createLibraryService({
  libraryRepo,
  audioMetadataClient,
  musicDir: MUSIC_DIR,
  onDeleteCallback: async () => {
    await buncasterService.queueClear(false);
  },
});

const torrentService = new TorrentService();
torrentService.startWorker();

const orchestratorService = new OrchestratorService(
  libraryRepo,
  libraryService,
  buncasterService,
  locutorService,
  playlistRepo,
  MUSIC_DIR,
  DATA_DIR
);

const ttsService = new TtsService(MUSIC_DIR);

const buncasterQueueService = new BuncasterQueueService(
  (filepath, script) => buncasterService.queuePush(filepath, script),
  MUSIC_DIR,
  libraryRepo,
  audioMetadataClient
);
buncasterQueueService.startWorker();
buncasterService.setQueueService(buncasterQueueService);

// Initialize library service (creates dirs, scans, starts watcher)
libraryService.init().catch((err) => console.error("[init] libraryService:", err));

// Start AI DJ Orchestrator
orchestratorService.start();

const queuePersistenceService = new QueuePersistenceService(
  buncasterService,
  playbackStateRepo,
  libraryService
);
queuePersistenceService.start();

// ============================================================
// 4. API & Static Router Instantiation
// ============================================================
const apiRouter = createApiRouter({
  configService,
  libraryRepo,
  libraryService,
  buncasterService,
  buncasterQueueService,
  playlistRepo,
  locutorService,
  torrentService,
  musicDir: MUSIC_DIR,
  distDir: DIST_DIR,
  ttsService,
});

// ============================================================
// 5. HTTP Server (Bun.serve)
// ============================================================
const _server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    return apiRouter.fetch(req);
  },
});

console.log(`[server] Radio Bloom API on port ${PORT}`);
console.log(`[server] API:    http://localhost:${PORT}/api/`);
console.log(`[server] Queues: http://localhost:${PORT}/admin/queues`);
console.log(`[server] Radio Bloom Composition Root ready`);

process.on("SIGINT", async () => {
  console.log("[shutdown] SIGINT received, shutting down gracefully...");
  orchestratorService.stop();
  libraryService.shutdown();
  _server.stop();
  await torrentService.close().catch(() => {});
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received, shutting down gracefully...");
  orchestratorService.stop();
  libraryService.shutdown();
  _server.stop();
  await torrentService.close().catch(() => {});
  process.exit(0);
});
