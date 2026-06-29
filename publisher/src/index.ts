import "./env";
import { resolve } from "node:path";
import { createApiRouter } from "./api/router";
import { DatabaseConnection } from "./infrastructure/database";
import { AudioMetadataClient } from "./infrastructure/audio-metadata.client";
import { TelnetClient } from "./infrastructure/telnet.client";
import { ConfigRepository } from "./repositories/sqlite/config.repo";
import { LibraryRepository } from "./repositories/sqlite/library.repo";
import { PlaybackStateRepository } from "./repositories/sqlite/playback-state.repo";
import { PlaylistRepository } from "./repositories/sqlite/playlist.repo";
import { ConfigService } from "./services/config.service";
import { LibraryService } from "./services/library.service";
import { LiquidsoapService } from "./services/liquidsoap.service";
import { McpService } from "./services/mcp.service";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MUSIC_DIR = process.env.MUSIC_DIR || "/app/music";
const MUSIC_MOUNT = process.env.MUSIC_MOUNT || "/app/music";

const LIQUIDSOAP_HOST = process.env.LIQUIDSOAP_HOST || "liquidsoap";
const LIQUIDSOAP_TELNET_PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || "1234", 10);
const LIQUIDSOAP_HARBOUR_PORT = process.env.LIQUIDSOAP_HARBOUR_PORT || "8000";
const STREAM_URL = `http://${LIQUIDSOAP_HOST}:${LIQUIDSOAP_HARBOUR_PORT}/radiobloom.mp3`;

const DIST_DIR =
  process.env.NODE_ENV === "production"
    ? "/app/web/dist"
    : resolve(import.meta.dirname || "", "../../web/dist");

// ============================================================
// 1. Infrastructure & Connections Instantiation
// ============================================================
const dbPath = resolve(DATA_DIR, "radio.db");
const dbConnection = new DatabaseConnection(dbPath);

const telnetClient = new TelnetClient(LIQUIDSOAP_HOST, LIQUIDSOAP_TELNET_PORT);
const audioMetadataClient = new AudioMetadataClient();

// ============================================================
// 2. Repositories Instantiation (Data Access)
// ============================================================
const configRepo = new ConfigRepository(dbConnection);
const libraryRepo = new LibraryRepository(dbConnection);
const playlistRepo = new PlaylistRepository(dbConnection);
const playbackStateRepo = new PlaybackStateRepository(dbConnection);

// ============================================================
// 3. Services & Use Cases Instantiation
// ============================================================
const configService = new ConfigService(configRepo);
const liquidsoapService = new LiquidsoapService(telnetClient, audioMetadataClient, MUSIC_MOUNT);

const libraryService = new LibraryService(
  libraryRepo,
  audioMetadataClient,
  MUSIC_DIR,
  async () => {
    await liquidsoapService.queueClear();
  }
);

const mcpService = new McpService(
  libraryRepo,
  playlistRepo,
  libraryService,
  liquidsoapService
);

// Initialize library service (creates dirs, scans, starts watcher)
libraryService.init().catch((err) => console.error("[init] libraryService:", err));

// ============================================================
// Playback State Persistence & Restore
// ============================================================

// Restore playback state on startup (after Liquidsoap is likely ready)
setTimeout(async () => {
  const state = playbackStateRepo.get();
  if (!state?.file) {
    console.log("[restore] No saved state found. Starting fresh.");
    return;
  }

  console.log(`[restore] Previous track found: "${state.title}" by ${state.artist}`);

  const savedAtMs = new Date(state.savedAt).getTime();
  if (Number.isNaN(savedAtMs)) {
    playbackStateRepo.clear();
    return;
  }

  const secondsSinceSave = (Date.now() - savedAtMs) / 1000;
  const currentElapsed = state.elapsed + secondsSinceSave;

  if (state.duration > 0 && currentElapsed >= state.duration) {
    console.log("[restore] Previous track would have ended. Starting fresh.");
    playbackStateRepo.clear();
    return;
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    if (liquidsoapService.isConnected()) {
      console.log(`[restore] Resuming "${state.file}" at ~${Math.round(currentElapsed)}s`);

      const rid = await liquidsoapService.queuePush(state.file);
      if (!rid) {
        console.log("[restore] Failed to push track to queue.");
        return;
      }

      await new Promise((r) => setTimeout(r, 1000));
      await liquidsoapService.sendCommand("queue.skip");

      await new Promise((r) => setTimeout(r, 800));

      const currentRid = await liquidsoapService.getCurrentRequestId();
      if (currentRid) {
        const seekPos = Math.max(0, currentElapsed);
        const ok = await liquidsoapService.requestSeek(currentRid, seekPos);
        console.log(
          `[restore] Seek to ${Math.round(seekPos)}s: ${ok ? "OK" : "failed, playing from start"}`
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("[restore] Liquidsoap not available after 60s, skipping restore.");
}, 3000);

// Persist current playback state every 15 seconds
setInterval(async () => {
  try {
    const status = await liquidsoapService.getStreamStatus();
    if (!status.playing || !status.metadata) return;

    const file = status.metadata.filename || status.metadata.initial_uri || "";
    if (!file) return;

    playbackStateRepo.save({
      file,
      title: status.title || "",
      artist: status.artist || "",
      elapsed: status.elapsed,
      duration: status.duration,
    });
  } catch {}
}, 15000);

// ============================================================
// 4. API & Static Router Instantiation
// ============================================================
const apiRouter = createApiRouter({
  configService,
  libraryRepo,
  libraryService,
  liquidsoapService,
  playlistRepo,
  mcpService,
  musicDir: MUSIC_DIR,
  distDir: DIST_DIR,
});

// ============================================================
// 5. Burst Buffer Stream Broadcaster
// ============================================================
class StreamBroadcaster {
  private buffer: Uint8Array[] = [];
  private maxBufferBytes = 320 * 1024;
  private bufferBytes = 0;
  private clients: Set<ReadableStreamDefaultController> = new Set();
  private isStreaming = false;

  constructor() {
    this.startStreaming();
  }

  private async startStreaming() {
    if (this.isStreaming) return;
    this.isStreaming = true;

    while (true) {
      try {
        console.log(`[Broadcaster] Connecting to Liquidsoap upstream at ${STREAM_URL}...`);
        const res = await fetch(STREAM_URL);
        if (!res.ok || !res.body) {
          throw new Error(`Upstream returned status ${res.status}`);
        }

        const reader = res.body.getReader();
        console.log("[Broadcaster] Connected to upstream successfully.");
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log("[Broadcaster] Upstream connection closed.");
            break;
          }

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
      } catch (err: any) {
        console.error("[Broadcaster] Error in upstream stream connection:", err.message);
      }

      this.buffer = [];
      this.bufferBytes = 0;

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  public registerClient(controller: ReadableStreamDefaultController) {
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
          "Cache-Control": "no-cache, no-store, must-revalidate",
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
console.log(`[server] Radio Bloom Composition Root ready`);

process.on("SIGINT", async () => {
  libraryService.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  libraryService.shutdown();
  process.exit(0);
});
