import type { Context, Hono } from "hono";
import type { BuncasterService } from "../services/buncaster.service";
import { toPublicQueueItems } from "../services/buncaster.service";
import type { LiveService } from "../services/live.service";
import type { ReachService } from "../services/reach.service";
import type { SongRequestsService } from "../services/song-requests.service";
import { DEFAULT_PUBLIC_HOST } from "../services/status-json.mapper";
import {
  buildSessionCookie,
  clientIpFrom,
  createSession,
  isAuthenticated,
  isHttpsRequest,
  LoginGuard,
  requiresStudioAuth,
  resolveSessionSecret,
  SESSION_TTL_MS,
  type StudioAuthConfig,
  safeEqual,
} from "../services/studio-auth";

/** Client IP for rate limits/hashes: cf-connecting-ip → x-real-ip → x-forwarded-for[0] → socket. */
export function requestClientIp(c: Context): string {
  let socketIp: string | null = null;
  try {
    socketIp = c.env?.requestIP?.(c.req.raw)?.address ?? null;
  } catch {}
  return clientIpFrom(c.req.raw.headers, socketIp);
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/** Reads auth config from env (STUDIO_TOKEN / STUDIO_SESSION_SECRET). */
export function studioAuthFromEnv(env = process.env): StudioAuthConfig {
  return {
    token: env.STUDIO_TOKEN?.trim() || null,
    sessionSecret: env.STUDIO_SESSION_SECRET?.trim() || null,
  };
}

/**
 * Auth middleware + POST /api/studio/login, POST /api/studio/logout, GET /api/studio/me.
 * Must be registered BEFORE the routes it protects.
 */
export function registerStudioAuth(
  app: Hono,
  cfg: StudioAuthConfig,
  guard: LoginGuard = new LoginGuard()
): void {
  const enabled = !!cfg.token;
  const secret = resolveSessionSecret(cfg);

  app.use("*", async (c: any, next: any) => {
    if (!enabled) return next();
    if (!requiresStudioAuth(c.req.method, c.req.path)) return next();
    if (isAuthenticated(c.req.raw.headers, cfg)) return next();
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  });

  app.post("/api/studio/login", async (c) => {
    if (!enabled) return c.json({ ok: true, data: { authenticated: true } });
    const ip = requestClientIp(c);
    const retryAfter = guard.retryAfter(ip);
    if (retryAfter > 0) {
      return jsonResponse({ ok: false, error: "rate_limited", retryAfter }, 429, {
        "Retry-After": String(retryAfter),
      });
    }
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 512 || !safeEqual(token, cfg.token!)) {
      guard.recordFailure(ip);
      console.warn(`[studio] failed login from ${ip}`);
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }
    guard.reset(ip);
    const session = createSession(secret);
    const cookie = buildSessionCookie(session.value, {
      secure: isHttpsRequest(c.req.raw.headers),
      maxAgeSeconds: SESSION_TTL_MS / 1000,
    });
    return jsonResponse(
      { ok: true, data: { authenticated: true, expiresAt: session.expiresAt } },
      200,
      { "Set-Cookie": cookie }
    );
  });

  app.post("/api/studio/logout", (c) => {
    const cookie = buildSessionCookie("", {
      secure: isHttpsRequest(c.req.raw.headers),
      maxAgeSeconds: 0,
    });
    return jsonResponse({ ok: true, data: { authenticated: false } }, 200, {
      "Set-Cookie": cookie,
    });
  });

  app.get("/api/studio/me", (c) => {
    const authenticated = !enabled || isAuthenticated(c.req.raw.headers, cfg);
    return jsonResponse({ ok: true, data: { authenticated } }, 200);
  });
}

export interface StudioRouteDeps {
  liveService: LiveService;
  buncasterService: Pick<BuncasterService, "queueList" | "skipTrack">;
  requests: SongRequestsService;
  reach: ReachService;
  env?: NodeJS.ProcessEnv;
}

export function buildSrtUrl(env: NodeJS.ProcessEnv): {
  srtUrl: string;
  streamKeyConfigured: boolean;
} {
  const host = env.PUBLIC_HOST?.trim() || DEFAULT_PUBLIC_HOST;
  const port = env.SRT_PORT?.trim() || "1936";
  const key = env.RTMP_STREAM_KEY?.trim() || "";
  return {
    srtUrl: key
      ? `srt://${host}:${port}?streamid=live/${encodeURIComponent(key)}`
      : `srt://${host}:${port}`,
    streamKeyConfigured: !!key,
  };
}

/** Authenticated studio endpoints (protected by the middleware above). */
export function registerStudioRoutes(app: Hono, deps: StudioRouteDeps): void {
  const env = deps.env ?? process.env;

  app.get("/api/studio/overview", async () => {
    const [now, queue, engine] = await Promise.all([
      deps.liveService.getNow(),
      deps.buncasterService
        .queueList()
        .then((r) => toPublicQueueItems(r.items))
        .catch(() => []),
      deps.reach.getEngine(),
    ]);
    return jsonResponse(
      {
        ok: true,
        data: {
          now,
          queue,
          requestsPending: deps.requests.pendingCount(),
          listeners24h: deps.reach.series(),
          engine,
          live: buildSrtUrl(env),
        },
      },
      200
    );
  });

  app.get("/api/studio/requests", () => {
    return jsonResponse({ ok: true, data: deps.requests.listStudio() }, 200);
  });

  app.post("/api/studio/requests/:id/approve", async (c) => {
    const res = await deps.requests.approve(c.req.param("id"));
    if (!res.ok) return c.json({ ok: false, error: res.error }, res.status);
    return c.json({ ok: true, data: res.data });
  });

  app.post("/api/studio/requests/:id/reject", async (c) => {
    const res = await deps.requests.reject(c.req.param("id"));
    if (!res.ok) return c.json({ ok: false, error: res.error }, res.status);
    return c.json({ ok: true, data: res.data });
  });

  app.post("/api/studio/queue", async (c) => {
    const body = await c.req.json().catch(() => null);
    const res = await deps.requests.enqueueTrack(body?.trackId);
    if (!res.ok) return c.json({ ok: false, error: res.error }, res.status);
    return c.json({ ok: true, data: { queued: true } });
  });

  app.post("/api/studio/skip", async (c) => {
    try {
      await deps.buncasterService.skipTrack();
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });
}
