import "./env";
import { resolve } from "node:path";
import { createApiRouter } from "./api/router";
import { DatabaseConnection } from "./infrastructure/database";
import { FfprobeClient } from "./infrastructure/ffprobe.client";
import { SpotiflacClient } from "./infrastructure/spotiflac.client";
import { TelnetClient } from "./infrastructure/telnet.client";
import { ConfigRepository } from "./repositories/sqlite/config.repo";
import { LibraryRepository } from "./repositories/sqlite/library.repo";
import { PlaylistRepository } from "./repositories/sqlite/playlist.repo";
import { ConfigService } from "./services/config.service";
import { DownloadService } from "./services/download.service";
import { LibraryService } from "./services/library.service";
import { LiquidsoapService } from "./services/liquidsoap.service";
import { McpService } from "./services/mcp.service";
import { MetadataEnrichmentService } from "./services/metadata-enrichment.service";

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MUSIC_DIR = process.env.MUSIC_DIR || "/app/music";
const SONGS_DIR = resolve(MUSIC_DIR, "songs");
const MUSIC_MOUNT = process.env.MUSIC_MOUNT || "/app/music";

const LIQUIDSOAP_HOST = process.env.LIQUIDSOAP_HOST || "liquidsoap";
const LIQUIDSOAP_TELNET_PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || "1234", 10);
const LIQUIDSOAP_HARBOUR_PORT = process.env.LIQUIDSOAP_HARBOUR_PORT || "8000";
const STREAM_URL = `http://${LIQUIDSOAP_HOST}:${LIQUIDSOAP_HARBOUR_PORT}/radiobloom.mp3`;
const LIVE_HARBOUR_URL = `http://${LIQUIDSOAP_HOST}:8001/live.mp3`;
const LIVE_AUTH = `Basic ${Buffer.from("source:hackme").toString("base64")}`;

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
const ffprobeClient = new FfprobeClient();
const spotiflacClient = new SpotiflacClient(SONGS_DIR);

// ============================================================
// 2. Repositories Instantiation (Data Access)
// ============================================================
const configRepo = new ConfigRepository(dbConnection);
const libraryRepo = new LibraryRepository(dbConnection);
const playlistRepo = new PlaylistRepository(dbConnection);

// ============================================================
// 3. Services & Use Cases Instantiation
// ============================================================
const configService = new ConfigService(configRepo);
const liquidsoapService = new LiquidsoapService(telnetClient, ffprobeClient, MUSIC_MOUNT);

const metadataEnrichment = new MetadataEnrichmentService();

// LibraryService deletes should clear the Liquidsoap queue
const libraryService = new LibraryService(
  libraryRepo,
  ffprobeClient,
  MUSIC_DIR,
  metadataEnrichment,
  async () => {
    await liquidsoapService.queueClear();
  }
);

const downloadService = new DownloadService(libraryRepo, spotiflacClient, ffprobeClient, SONGS_DIR);

const mcpService = new McpService(libraryRepo, playlistRepo, libraryService, liquidsoapService);

// Initialize active services
libraryService.init();
downloadService.init();

// Auto re-download missing tracks on startup
setTimeout(() => {
  const results = downloadService.reDownloadMissing();
  if (results.length > 0) {
    console.log(`[startup] Re-downloading ${results.length} missing tracks...`);
  }
}, 5000);

// ============================================================
// 4. API & Static Router Instantiation
// ============================================================
const apiRouter = createApiRouter({
  configService,
  libraryRepo,
  libraryService,
  liquidsoapService,
  downloadService,
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
  private maxBufferBytes = 320 * 1024; // 320 KB (approx 8 seconds of audio at 320kbps)
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

          // Add to circular memory buffer
          this.buffer.push(value);
          this.bufferBytes += value.length;

          while (this.bufferBytes > this.maxBufferBytes) {
            const removed = this.buffer.shift();
            if (removed) {
              this.bufferBytes -= removed.length;
            }
          }

          // Distribute chunk to active clients
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

      // Reset buffer on error to prevent old data looping
      this.buffer = [];
      this.bufferBytes = 0;

      // Wait 2 seconds before attempting reconnection
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
// 6. HTTP Server (Bun.serve) with WebSocket for browser live
// ============================================================
const _server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket for browser live streaming
    if (url.pathname === "/ws/live") {
      const upgraded = server.upgrade(req);
      if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
      return;
    }

    // PUT /live.mp3: FFmpeg envía audio en vivo al harbor de Liquidsoap
    if (url.pathname === "/live.mp3" && req.method === "PUT") {
      try {
        const headers = new Headers(req.headers);
        headers.delete("host");
        const upRes = await fetch(LIVE_HARBOUR_URL, {
          method: "PUT",
          headers,
          body: req.body,
          duplex: "half",
        });
        return new Response(upRes.body, {
          status: upRes.status,
          statusText: upRes.statusText,
        });
      } catch {
        return new Response("Live upstream not available", { status: 502 });
      }
    }

    // Audio stream route (único endpoint /radiobloom.mp3)
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

    // Delegate REST, static files, and MCP to Hono
    return apiRouter.fetch(req);
  },
  websocket: {
    open(ws) {
      console.log("[ws/live] Browser connected for live streaming");
      let streamController: ReadableStreamDefaultController | null = null;

      const body = new ReadableStream({
        start(c) { streamController = c; },
        cancel() { ws.close(); },
      });

      ws.data = { streamController };

      fetch(LIVE_HARBOUR_URL, {
        method: "PUT",
        headers: {
          "Content-Type": "audio/webm;codecs=opus",
          Authorization: LIVE_AUTH,
        },
        body,
        duplex: "half",
      }).then((res) => {
        console.log(`[ws/live] Harbor responded: ${res.status}`);
      }).catch((err) => {
        console.error("[ws/live] Harbor error:", err.message);
        ws.close();
      });
    },
    message(ws, message) {
      if (typeof message === "string") return;
      if (ws.data?.streamController) {
        try {
          ws.data.streamController.enqueue(message);
        } catch {
          ws.close();
        }
      }
    },
    close(ws) {
      console.log("[ws/live] Browser disconnected");
      if (ws.data?.streamController) {
        try { ws.data.streamController.close(); } catch {}
      }
    },
  },
});

console.log(`[server] Radio Bloom API + Stream on port ${PORT}`);
console.log(`[server] Stream: http://localhost:${PORT}/radiobloom.mp3`);
console.log(`[server] API:    http://localhost:${PORT}/api/`);
console.log(`[server] MCP:    http://localhost:${PORT}/mcp`);
console.log(`[server] Radio Bloom Composition Root ready`);
