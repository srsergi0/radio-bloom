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
import { McpService } from "./services/mcp.service";
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
const STREAM_URL = `http://${BUNCASTER_HOST}:${BUNCASTER_PORT}/stream`;

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

const mcpService = new McpService(
  libraryRepo,
  playlistRepo,
  libraryService,
  buncasterService,
  torrentService
);

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
  mcpService,
  torrentService,
  musicDir: MUSIC_DIR,
  distDir: DIST_DIR,
  ttsService,
});

// ============================================================
// 5. Burst Buffer Stream Broadcaster
// ============================================================
// Standard Silent MP3 Frame at 320kbps, 44.1kHz, Stereo (~26ms of audio)
const SILENT_MP3_FRAME = new Uint8Array([
  0xff,
  0xfb,
  0xe0,
  0x64,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  ...new Array(1024).fill(0),
  0x00,
  0x00,
  0x00,
  0x00,
]);

class StreamBroadcaster {
  private buffer: Uint8Array[] = [];
  private maxBufferBytes = 1.5 * 1024 * 1024; // 1.5 MB Buffer (~38 seconds cushion)
  private bufferBytes = 0;
  private clients: Set<ReadableStreamDefaultController> = new Set();
  private isStreaming = false;
  private static readonly MAX_CLIENTS = 500;

  constructor() {
    this.startStreaming();
  }

  private async startStreaming() {
    if (this.isStreaming) return;
    this.isStreaming = true;

    while (true) {
      try {
        console.log(`[Broadcaster] Connecting to Buncaster upstream at ${STREAM_URL}...`);
        const res = await fetch(STREAM_URL);
        if (!res.ok || !res.body) {
          throw new Error(`Upstream returned status ${res.status}`);
        }

        const reader = res.body.getReader();
        console.log("[Broadcaster] Connected to upstream successfully.");
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log(
              "[Broadcaster] Upstream connection closed. Switching to silent frames fallback..."
            );
            break;
          }

          this.pushData(value);
        }
      } catch (err: any) {
        console.error("[Broadcaster] Upstream connection failed:", err.message);

        // Moonshot Fallback: Keep generating silent frames to maintain client connections alive
        console.log(
          "[Broadcaster] Initiating hot-standby silence loop to protect client connections."
        );
        let silenceDurationMs = 0;

        // Inject silence for up to 30 seconds before attempting full reconnect loop
        while (silenceDurationMs < 30000 && this.clients.size > 0) {
          this.pushData(SILENT_MP3_FRAME);
          // 1 MP3 frame at 44.1kHz is ~26.12ms of audio
          await new Promise((resolve) => setTimeout(resolve, 26));
          silenceDurationMs += 26;
        }
      }

      this.buffer = [];
      this.bufferBytes = 0;

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  private pushData(value: Uint8Array) {
    this.buffer.push(value);
    this.bufferBytes += value.length;

    while (this.bufferBytes > this.maxBufferBytes) {
      const removed = this.buffer.shift();
      if (removed) {
        this.bufferBytes -= removed.length;
      }
    }

    for (const client of this.clients) {
      try {
        client.enqueue(value);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  public registerClient(controller: ReadableStreamDefaultController) {
    if (this.clients.size >= StreamBroadcaster.MAX_CLIENTS) {
      console.warn(
        `[Broadcaster] Max clients reached (${StreamBroadcaster.MAX_CLIENTS}). Rejecting.`
      );
      try {
        controller.close();
      } catch {}
      return;
    }
    for (const chunk of this.buffer) {
      try {
        controller.enqueue(chunk);
      } catch {
        return;
      }
    }
    this.clients.add(controller);
    console.log(`[Broadcaster] Client connected. Total active clients: ${this.clients.size}`);
  }

  public unregisterClient(controller: ReadableStreamDefaultController) {
    this.clients.delete(controller);
    console.log(`[Broadcaster] Client disconnected. Total active clients: ${this.clients.size}`);
  }
}

const broadcaster = new StreamBroadcaster();

// ============================================================
// 6. HTTP Server (Bun.serve)
// ============================================================
const _server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/radiobloom.mp3") {
      let clientController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          clientController = controller;
          broadcaster.registerClient(controller);
        },
        cancel() {
          if (clientController) {
            broadcaster.unregisterClient(clientController);
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-cache, no-store, must-revalidate, pre-check=0, post-check=0",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Content-Encoding": "identity",
          Pragma: "no-cache",
          Expires: "0",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return apiRouter.fetch(req);
  },
});

console.log(`[server] Radio Bloom API + Stream on port ${PORT}`);
console.log(`[server] Stream: http://localhost:${PORT}/radiobloom.mp3`);
console.log(`[server] API:    http://localhost:${PORT}/api/`);
console.log(`[server] MCP:    http://localhost:${PORT}/mcp`);
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
