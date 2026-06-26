import api from "./api";
import { initLiquidsoap } from "./liquidsoap";
import { initLibrary } from "./library";
import { initDB } from "./db";

const PORT = parseInt(process.env.PORT || "3000");
const LIQUIDSOAP_HOST = process.env.LIQUIDSOAP_HOST || "liquidsoap";
const LIQUIDSOAP_HARBOUR_PORT = process.env.LIQUIDSOAP_HARBOUR_PORT || "8000";
const STREAM_URL = `http://${LIQUIDSOAP_HOST}:${LIQUIDSOAP_HARBOUR_PORT}/radiobloom.mp3`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Proxy streaming endpoint
    if (url.pathname === "/radiobloom.mp3") {
      try {
        const upstream = await fetch(STREAM_URL);

        if (!upstream.ok || !upstream.body) {
          return new Response("Stream unavailable", { status: 502 });
        }

        return new Response(upstream.body, {
          status: 200,
          headers: {
            "Content-Type": "audio/mpeg",
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err: any) {
        return new Response("Stream connection failed", { status: 502 });
      }
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

initDB();
initLibrary();
initLiquidsoap();

console.log(`[server] Radio Bloom ready`);
