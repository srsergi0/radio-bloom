import "./env";
import api from "./api";
import { initDB } from "./db";
import { initLibrary } from "./library";
import { initLiquidsoap } from "./liquidsoap";
import { createHttpTransport } from "./mcp";

const PORT = parseInt(process.env.PORT || "3000", 10);
const LIQUIDSOAP_HOST = process.env.LIQUIDSOAP_HOST || "liquidsoap";
const LIQUIDSOAP_HARBOUR_PORT = process.env.LIQUIDSOAP_HARBOUR_PORT || "8000";
const STREAM_URL = `http://${LIQUIDSOAP_HOST}:${LIQUIDSOAP_HARBOUR_PORT}/radiobloom.mp3`;

// Broadcaster class that maintains a sliding memory buffer of the stream
// and sends it to new clients immediately upon connection (Burst-on-Connect)
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

          // Distribute the chunk to all active client streams
          for (const client of this.clients) {
            try {
              client.enqueue(value);
            } catch {
              this.clients.delete(client);
            }
          }
        }
      } catch (err) {
        console.error("[Broadcaster] Error in upstream stream connection:", err);
      }

      // Reset buffer on error to prevent old/stale data looping
      this.buffer = [];
      this.bufferBytes = 0;
      
      // Wait 2 seconds before attempting reconnection
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  public registerClient(controller: ReadableStreamDefaultController) {
    // 1. Deliver the burst (buffered historical audio) instantly
    for (const chunk of this.buffer) {
      try {
        controller.enqueue(chunk);
      } catch {
        return;
      }
    }
    // 2. Add client to set for receiving live chunks
    this.clients.add(controller);
    console.log(`[Broadcaster] Client connected. Total active clients: ${this.clients.size}`);
  }

  public unregisterClient(controller: ReadableStreamDefaultController) {
    this.clients.delete(controller);
    console.log(`[Broadcaster] Client disconnected. Total active clients: ${this.clients.size}`);
  }
}

const broadcaster = new StreamBroadcaster();

const _server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Proxy streaming endpoint
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

    // API routes
    return api.fetch(req);
  },
});

console.log(`[server] Radio Bloom API + Stream on port ${PORT}`);
console.log(`[server] Stream: http://localhost:${PORT}/radiobloom.mp3`);
console.log(`[server] API:    http://localhost:${PORT}/api/`);
console.log(`[server] Endpoints:`);
console.log(`  GET  /radiobloom.mp3          ← Stream de audio`);
console.log(`  GET  /api/health`);
console.log(`  GET  /api/system/status`);
console.log(`  GET  /api/system/config`);
console.log(`  PUT  /api/system/config`);
console.log(`  GET  /api/library`);
console.log(`  GET  /api/library/songs`);
console.log(`  GET  /api/library/interludios`);
console.log(`  GET  /api/library/stats`);
console.log(`  GET  /api/library/search?q=...`);
console.log(`  GET  /api/library/track?file=...`);
console.log(`  DEL  /api/library/track?file=...`);
console.log(`  POST /api/library/scan`);
console.log(`  GET  /api/stream`);
console.log(`  POST /api/stream/play`);
console.log(`  POST /api/stream/pause`);
console.log(`  GET  /api/stream/skip`);
console.log(`  POST /api/stream/skip`);
console.log(`  POST /api/stream/reload`);
console.log(`  POST /api/stream/queue     (body: {"url":"..."})`);
console.log(`  GET  /api/stream/queue`);
console.log(`  DEL  /api/stream/queue`);
console.log(`  DEL  /api/stream/queue/:rid`);
console.log(`  POST /api/stream/queue/insert  (body: {"index", "url"})`);
console.log(`  POST /api/stream/play/url  (body: {"url":"..."})`);
console.log(`  POST /api/library/:id/play`);
console.log(`  ALL  /mcp                     ← MCP protocol (Streamable HTTP)`);

initDB();
initLibrary();
initLiquidsoap();
createHttpTransport();

console.log(`[server] Radio Bloom ready`);
