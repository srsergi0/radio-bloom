import type { Hono } from "hono";
import type { CoverService } from "../services/cover.service";
import { isValidTrackKey } from "../services/live.mapper";
import type { LiveService, LiveSubscriber } from "../services/live.service";

export interface LiveRouteDeps {
  liveService: LiveService;
  coverService: CoverService;
}

/** Routes that must bypass the per-IP rate limiter (many listeners can share one proxy IP). */
export function isRateLimitExempt(path: string): boolean {
  return path === "/api/live/events" || path.startsWith("/api/live/cover/");
}

const SSE_MAX_QUEUED_CHUNKS = 64; // slow client → dropped instead of buffering forever
const encoder = new TextEncoder();

/**
 * Public, read-only listener API. Everything is served from LiveService's in-memory
 * snapshot (one shared Buncaster poller), never by polling upstream per request.
 */
export function registerLiveRoutes(app: Hono, deps: LiveRouteDeps): void {
  const { liveService, coverService } = deps;

  app.get("/api/live/now", async (c) => {
    return c.json({ ok: true, data: await liveService.getNow() });
  });

  app.get("/api/live/history", (c) => {
    const raw = Number.parseInt(c.req.query("limit") || "20", 10);
    const limit = Number.isFinite(raw) ? Math.min(50, Math.max(1, raw)) : 20;
    return c.json({ ok: true, data: liveService.getHistory(limit) });
  });

  app.get("/api/live/schedule", (c) => {
    return c.json({ ok: true, data: liveService.getSchedule() });
  });

  app.get("/api/live/cover/:key", async (c) => {
    const key = (c.req.param("key") || "").replace(/\.jpg$/, "");
    if (!isValidTrackKey(key)) return c.json({ ok: false, error: "Invalid cover key" }, 400);
    const path = await coverService.ensure(key);
    if (!path) {
      return new Response(JSON.stringify({ ok: false, error: "Cover not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": coverService.isKnownMiss(key) ? "public, max-age=600" : "no-cache",
        },
      });
    }
    return new Response(Bun.file(path), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  app.get("/api/live/events", (c) => {
    if (liveService.isFull()) {
      return c.json({ ok: false, error: "Too many live subscribers, retry later" }, 503);
    }
    const signal = c.req.raw.signal;
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const cleanup = () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          unsubscribe = null;
          try {
            controller.close();
          } catch {}
        };
        const sub: LiveSubscriber = {
          send(chunk) {
            if (closed) return false;
            if ((controller.desiredSize ?? 0) < -SSE_MAX_QUEUED_CHUNKS) return false;
            try {
              controller.enqueue(encoder.encode(chunk));
              return true;
            } catch {
              return false;
            }
          },
          close: cleanup,
        };
        signal?.addEventListener("abort", cleanup, { once: true });

        const unsub = await liveService.subscribe(sub);
        if (!unsub) {
          cleanup();
          return;
        }
        if (closed || signal?.aborted) {
          unsub();
          cleanup();
          return;
        }
        unsubscribe = unsub;
      },
      cancel() {
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
