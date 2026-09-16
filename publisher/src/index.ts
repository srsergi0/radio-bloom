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
// Tier del stream: "dual" (mp3 + opus) | "opus" (solo opus) | "mp3" (solo mp3)
const STREAM_TIER = (process.env.STREAM_TIER || "dual").toLowerCase();
const OPUS_ENABLED = STREAM_TIER !== "mp3";
const MP3_ENABLED = STREAM_TIER !== "opus";
// Upstreams hacia buncaster (overridables si el tier único se sirve en otra ruta)
const MP3_URL = process.env.MP3_UPSTREAM_URL || `http://${BUNCASTER_HOST}:${BUNCASTER_PORT}/mp3`;
const OPUS_URL = process.env.OPUS_UPSTREAM_URL || `http://${BUNCASTER_HOST}:${BUNCASTER_PORT}/opus`;
const STREAM_URL = MP3_URL; // legacy alias para broadcaster mp3
const USE_OPUS = OPUS_ENABLED;

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
// 5. Stream Broadcaster (proxy from Buncaster)
// ============================================================
const SILENT_MP3_FRAME = new Uint8Array([
  0xff, 0xfb, 0xe0, 0x64, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ...new Array(1024).fill(0),
  0x00, 0x00, 0x00, 0x00,
]);

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Devuelve las 2 primeras páginas Ogg (OpusHead + OpusTags) si el buffer empieza con ellas
function extractOggOpusHeaders(buf: Uint8Array): Uint8Array | null {
  let offset = 0;
  let pagesFound = 0;
  while (offset + 27 <= buf.length) {
    if (buf[offset] !== 0x4f || buf[offset + 1] !== 0x67 || buf[offset + 2] !== 0x67 || buf[offset + 3] !== 0x53) {
      return null;
    }
    const numSegments = buf[offset + 26];
    if (offset + 27 + numSegments > buf.length) return null;
    let payloadLen = 0;
    for (let i = 0; i < numSegments; i++) payloadLen += buf[offset + 27 + i];
    const pageLen = 27 + numSegments + payloadLen;
    if (offset + pageLen > buf.length) return null;
    pagesFound++;
    offset += pageLen;
    if (pagesFound === 2) return buf.slice(0, offset);
  }
  return null;
}

class StreamBroadcaster {
  private buffer: Uint8Array[] = [];
  private maxBufferBytes = 1.5 * 1024 * 1024;
  private bufferBytes = 0;
  private clients: Set<ReadableStreamDefaultController> = new Set();
  private isStreaming = false;
  private static readonly MAX_CLIENTS = 500;

  // Cabeceras Ogg/Opus (OpusHead + OpusTags) que hay que anteponer a cada oyente nuevo
  private headerBytes: Uint8Array | null = null;
  private headerScan: Uint8Array[] = [];
  private headerScanBytes = 0;
  private headerDone = false;

  constructor(
    private readonly upstreamUrl: string,
    private readonly label: string,
    private readonly captureOggHeaders = false,
  ) {
    this.startStreaming();
  }

  private async startStreaming() {
    if (this.isStreaming) return;
    this.isStreaming = true;

    while (true) {
      try {
        // Cada conexión nueva a buncaster vuelve a recibir las cabeceras: recaptúralas
        this.headerDone = false;
        this.headerScan = [];
        this.headerScanBytes = 0;

        console.log(`[Broadcaster:${this.label}] Connecting to Buncaster upstream at ${this.upstreamUrl}...`);
        const auth = "Basic " + Buffer.from(`${BUNCASTER_ADMIN_USER}:${BUNCASTER_ADMIN_PASSWORD}`).toString("base64");
        const res = await fetch(this.upstreamUrl, { headers: { Authorization: auth } });
        if (!res.ok || !res.body) {
          throw new Error(`Upstream returned status ${res.status}`);
        }

        const reader = res.body.getReader();
        console.log(`[Broadcaster:${this.label}] Connected to upstream successfully.`);
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log(`[Broadcaster:${this.label}] Upstream connection closed. Reconnecting...`);
            break;
          }
          this.pushData(value);
        }
      } catch (err: any) {
        console.error(`[Broadcaster:${this.label}] Upstream connection failed:`, err.message);
        let silenceMs = 0;
        while (silenceMs < 30000 && this.clients.size > 0) {
          this.roll(SILENT_MP3_FRAME);
          await new Promise((r) => setTimeout(r, 26));
          silenceMs += 26;
        }
      }

      this.buffer = [];
      this.bufferBytes = 0;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private pushData(value: Uint8Array) {
    if (this.captureOggHeaders && !this.headerDone) {
      this.headerScan.push(value);
      this.headerScanBytes += value.length;
      const combined = concatBytes(this.headerScan);
      const headers = extractOggOpusHeaders(combined);
      if (headers) {
        this.headerBytes = headers;
        this.headerDone = true;
        this.headerScan = [];
        this.headerScanBytes = 0;
        this.roll(combined.subarray(headers.length));
        return;
      }
      if (this.headerScanBytes >= 65536) {
        // No hay cabeceras Ogg (p. ej. MP3): deja de esperar y suelta lo retenido
        this.headerDone = true;
        this.headerScan = [];
        this.headerScanBytes = 0;
        this.roll(combined);
        return;
      }
      return;
    }
    this.roll(value);
  }

  private roll(value: Uint8Array) {
    if (value.length === 0) return;
    this.buffer.push(value);
    this.bufferBytes += value.length;
    while (this.bufferBytes > this.maxBufferBytes) {
      const removed = this.buffer.shift();
      if (removed) this.bufferBytes -= removed.length;
    }
    for (const client of this.clients) {
      try { client.enqueue(value); } catch { this.clients.delete(client); }
    }
  }

  public registerClient(controller: ReadableStreamDefaultController) {
    if (this.clients.size >= StreamBroadcaster.MAX_CLIENTS) {
      try { controller.close(); } catch {}
      return;
    }
    if (this.headerBytes && this.headerBytes.length > 0) {
      try { controller.enqueue(this.headerBytes); } catch { return; }
    }
    for (const chunk of this.buffer) {
      try { controller.enqueue(chunk); } catch { return; }
    }
    this.clients.add(controller);
  }

  public unregisterClient(controller: ReadableStreamDefaultController) {
    this.clients.delete(controller);
  }
}

const mp3Broadcaster = MP3_ENABLED ? new StreamBroadcaster(MP3_URL, "mp3") : null;
const opusBroadcaster = OPUS_ENABLED ? new StreamBroadcaster(OPUS_URL, "opus", true) : null;
const broadcaster = USE_OPUS ? opusBroadcaster! : mp3Broadcaster!; // alias para compatibilidad

// ============================================================
// 6. HTTP Server (Bun.serve)
// ============================================================
const _server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/radiobloom.mp3" || url.pathname === "/mp3") {
      const b = mp3Broadcaster;
      if (!b) return new Response("MP3 tier disabled", { status: 404 });
      let clientController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          clientController = controller;
          b.registerClient(controller);
        },
        cancel() {
          if (clientController) b.unregisterClient(clientController);
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Content-Encoding": "identity",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/radiobloom.opus" || url.pathname === "/opus") {
      const b = opusBroadcaster;
      if (!b) return new Response("Opus tier disabled", { status: 404 });
      let clientController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          clientController = controller;
          b.registerClient(controller);
        },
        cancel() {
          if (clientController) b.unregisterClient(clientController);
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "audio/ogg; codecs=opus",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Content-Encoding": "identity",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Default /radiobloom.* alias: usa Opus si está disponible
    if (url.pathname === "/radiobloom" || url.pathname === "/stream") {
      const useOpus = USE_OPUS && opusBroadcaster !== null;
      const targetBroadcaster = (useOpus ? opusBroadcaster : mp3Broadcaster)!;
      const mime = useOpus ? "audio/ogg; codecs=opus" : "audio/mpeg";
      let clientController: ReadableStreamDefaultController | null = null;
      const stream = new ReadableStream({
        start(controller) {
          clientController = controller;
          targetBroadcaster.registerClient(controller);
        },
        cancel() {
          if (clientController) targetBroadcaster.unregisterClient(clientController);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Content-Encoding": "identity",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return apiRouter.fetch(req);
  },
});

console.log(`[server] Radio Bloom API + Stream on port ${PORT}`);
console.log(`[server] STREAM_TIER = ${STREAM_TIER} (mp3: ${MP3_ENABLED ? "on" : "off"}, opus: ${OPUS_ENABLED ? "on" : "off"})`);
if (MP3_ENABLED) console.log(`[server] Stream MP3:  http://localhost:${PORT}/radiobloom.mp3  (→ ${MP3_URL})`);
if (OPUS_ENABLED) console.log(`[server] Stream Opus: http://localhost:${PORT}/radiobloom.opus (→ ${OPUS_URL}) ${USE_OPUS ? "[default]" : ""}`);
console.log(`[server] API:    http://localhost:${PORT}/api/`);
console.log(`[server] Queues: http://localhost:${PORT}/admin/queues`);

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
