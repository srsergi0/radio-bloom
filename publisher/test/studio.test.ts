import { describe, expect, mock, test } from "bun:test";
import { createApiRouter } from "../src/api/router";
import { DatabaseConnection } from "../src/infrastructure/database";
import { HeartsRepository } from "../src/repositories/sqlite/hearts.repo";
import { LibraryRepository } from "../src/repositories/sqlite/library.repo";
import { ListenerSamplesRepository } from "../src/repositories/sqlite/listener-samples.repo";
import { PlayHistoryRepository } from "../src/repositories/sqlite/play-history.repo";
import { SongRequestRepository } from "../src/repositories/sqlite/song-request.repo";
import { HeartsService } from "../src/services/hearts.service";
import { fileTrackKey } from "../src/services/live.mapper";
import {
  bucketOf,
  mapEngineHealth,
  REACH_BUCKET_MS,
  ReachService,
} from "../src/services/reach.service";
import {
  checkRequestLimits,
  containsUrl,
  REQUEST_IP_COOLDOWN_MS,
  requestability,
  type SongRequestRow,
  sanitizeText,
  selectPublicRequests,
  shouldAutoApprove,
  validateRequestInput,
} from "../src/services/song-requests.mapper";
import { SongRequestsService } from "../src/services/song-requests.service";
import { buildIcecastStatus, nowTitle, publicOrigin } from "../src/services/status-json.mapper";
import {
  buildSessionCookie,
  clientIpFrom,
  createSession,
  isAuthenticated,
  isHttpsRequest,
  LoginGuard,
  requiresStudioAuth,
  SESSION_TTL_MS,
  verifySession,
} from "../src/services/studio-auth";

const TOKEN = "t".repeat(64);
const SECRET = "s".repeat(64);
const h = (o: Record<string, string> = {}) => new Headers(o);

// ── Access matrix (pure) ──────────────────────────────────────

describe("studio-auth — access matrix", () => {
  const cases: [string, string, boolean][] = [
    // mutations under /api are protected...
    ["POST", "/api/stream/skip", true],
    ["POST", "/api/stream/queue", true],
    ["DELETE", "/api/stream/queue", true],
    ["DELETE", "/api/stream/queue/3", true],
    ["DELETE", "/api/library/track/x", true],
    ["POST", "/api/library/upload", true],
    ["POST", "/api/torrents/queue", true],
    ["PUT", "/api/system/config", true],
    ["PATCH", "/api/anything", true],
    ["POST", "/api/studio/logout", true],
    ["POST", "/api/studio/requests/req_1/approve", true],
    // ...except the public listener ones
    ["POST", "/api/studio/login", false],
    ["POST", "/api/live/requests", false],
    ["POST", "/api/live/hearts", false],
    // sensitive GETs
    ["GET", "/api/stream/skip", true],
    ["HEAD", "/api/stream/skip", true],
    ["GET", "/api/library/rescan", true],
    ["GET", "/api/torrents/search", true],
    ["GET", "/api/torrents/jobs/1/logs", true],
    ["GET", "/api/system/config", true],
    ["GET", "/api/studio/overview", true],
    ["GET", "/api/studio/requests", true],
    ["GET", "/buncaster-admin/", true],
    ["POST", "/buncaster-admin/api/skip", true],
    ["GET", "/buncaster-events", true],
    ["GET", "/admin/queues", true],
    ["GET", "/admin/queues/api/x", true],
    // public GETs
    ["GET", "/api/studio/me", false],
    ["GET", "/api/stream/queue", false],
    ["GET", "/api/stream", false],
    ["GET", "/api/system/status", false],
    ["GET", "/api/live/now", false],
    ["GET", "/api/live/search", false],
    ["GET", "/api/live/requests", false],
    ["GET", "/api/library/search", false],
    ["GET", "/status-json.xsl", false],
    ["GET", "/", false],
    ["GET", "/radiobloom.opus", false],
    ["OPTIONS", "/api/stream/skip", false],
    // path tricks normalise to the protected route
    ["GET", "/api/stream/%73kip", true],
    ["GET", "/API/Stream/Skip", true],
    ["GET", "/api/stream/skip/", true],
    ["GET", "//api//stream//skip", true],
    ["GET", "/api/studio/me/../overview", true],
    ["POST", "/api/live/requests/", false],
  ];
  for (const [method, path, expected] of cases) {
    test(`${method} ${path} → ${expected ? "protected" : "public"}`, () => {
      expect(requiresStudioAuth(method, path)).toBe(expected);
    });
  }
});

describe("studio-auth — credentials", () => {
  test("bearer token, wrong token, missing token", () => {
    const cfg = { token: TOKEN, sessionSecret: SECRET };
    expect(isAuthenticated(h({ authorization: `Bearer ${TOKEN}` }), cfg)).toBe(true);
    expect(isAuthenticated(h({ authorization: `bearer ${TOKEN}` }), cfg)).toBe(true);
    expect(isAuthenticated(h({ authorization: `Bearer ${TOKEN}x` }), cfg)).toBe(false);
    expect(isAuthenticated(h(), cfg)).toBe(false);
    // auth disabled → never "authenticated" (the middleware lets everything through instead)
    expect(isAuthenticated(h({ authorization: "Bearer " }), { token: null })).toBe(false);
  });

  test("session cookie: valid, tampered, expired, wrong secret", () => {
    const now = 1_700_000_000_000;
    const { value, expiresAt } = createSession(SECRET, now);
    expect(expiresAt).toBe(now + SESSION_TTL_MS);
    expect(verifySession(value, SECRET, now + 1000)).toBe(true);
    expect(verifySession(value, SECRET, expiresAt + 1)).toBe(false);
    expect(verifySession(value, "other", now)).toBe(false);
    const [exp, nonce, mac] = value.split(".");
    expect(verifySession(`${Number(exp) + 1}.${nonce}.${mac}`, SECRET, now)).toBe(false);
    expect(verifySession("garbage", SECRET, now)).toBe(false);
    const cfg = { token: TOKEN, sessionSecret: SECRET };
    expect(isAuthenticated(h({ cookie: `a=1; bloom_studio=${value}` }), cfg, now)).toBe(true);
  });

  test("cookie flags", () => {
    const c = buildSessionCookie("v", { secure: true, maxAgeSeconds: 60 });
    expect(c).toContain("bloom_studio=v");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).toContain("Secure");
    expect(buildSessionCookie("v", { secure: false, maxAgeSeconds: 60 })).not.toContain("Secure");
    expect(isHttpsRequest(h({ "x-forwarded-proto": "https" }))).toBe(true);
    expect(isHttpsRequest(h({ "cf-visitor": '{"scheme":"https"}' }))).toBe(true);
    expect(isHttpsRequest(h({ "x-forwarded-proto": "http" }))).toBe(false);
  });

  test("client IP precedence", () => {
    const all = {
      "cf-connecting-ip": "1.1.1.1",
      "x-real-ip": "2.2.2.2",
      "x-forwarded-for": "3.3.3.3, 4.4.4.4",
    };
    expect(clientIpFrom(h(all), "9.9.9.9")).toBe("1.1.1.1");
    expect(clientIpFrom(h({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" }))).toBe(
      "2.2.2.2"
    );
    expect(clientIpFrom(h({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" }))).toBe("3.3.3.3");
    expect(clientIpFrom(h(), "9.9.9.9")).toBe("9.9.9.9");
    expect(clientIpFrom(h())).toBe("unknown");
  });

  test("login guard: 10 failures / 15 min", () => {
    const g = new LoginGuard(10, 15 * 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i++) g.recordFailure("ip", t0 + i);
    expect(g.retryAfter("ip", t0 + 10)).toBe(0);
    g.recordFailure("ip", t0 + 10);
    expect(g.retryAfter("ip", t0 + 11)).toBeGreaterThan(890);
    expect(g.retryAfter("other", t0 + 11)).toBe(0);
    expect(g.retryAfter("ip", t0 + 15 * 60_000 + 1)).toBe(0);
  });
});

// ── Router-level middleware ───────────────────────────────────

function makeRouter(token: string | null) {
  const queueRemove = mock((_rid: string) => Promise.resolve(true));
  const skipTrack = mock(() => Promise.resolve());
  const buncasterService = {
    getHost: () => "localhost",
    getPort: () => 1,
    getAdminUser: () => "u",
    getAdminPass: () => "p",
    isConnected: () => true,
    skipTrack,
    getStreamStatus: () => Promise.resolve({ connected: true }),
    queueList: () => Promise.resolve({ items: [], total: 0 }),
    queueRemove,
    queueClear: () => Promise.resolve(),
  };
  const app = createApiRouter({
    configService: { get: () => ({}), update: () => ({}) } as any,
    libraryRepo: {} as any,
    libraryService: { rescan: () => Promise.resolve() } as any,
    buncasterService: buncasterService as any,
    buncasterQueueService: {} as any,
    playlistRepo: {} as any,
    locutorService: {} as any,
    torrentService: {} as any,
    musicDir: "/tmp/none",
    distDir: "/tmp/none",
    ttsService: {} as any,
    studioAuth: { token, sessionSecret: SECRET },
  });
  let ipN = 0;
  const call = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown
  ) => {
    const init: RequestInit = {
      method,
      headers: { "cf-connecting-ip": `10.0.0.${++ipN % 250}`, ...headers },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    return app.fetch(new Request(new URL(path, "http://localhost"), init));
  };
  return { call, queueRemove, skipTrack };
}

describe("router — studio auth middleware", () => {
  test("STUDIO_TOKEN unset → control API stays open", async () => {
    const { call } = makeRouter(null);
    expect((await call("POST", "/api/stream/skip")).status).toBe(200);
    expect((await call("GET", "/api/stream/skip")).status).toBe(200);
    const me = await (await call("GET", "/api/studio/me")).json();
    expect(me).toEqual({ ok: true, data: { authenticated: true } });
  });

  test("token set: 401 without credentials, 200 with bearer", async () => {
    const { call } = makeRouter(TOKEN);
    const r = await call("POST", "/api/stream/skip");
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ ok: false, error: "unauthorized" });
    expect((await call("GET", "/api/stream/skip")).status).toBe(401);
    expect((await call("GET", "/api/stream/%73kip")).status).toBe(401);
    expect((await call("DELETE", "/api/stream/queue")).status).toBe(401);
    expect((await call("GET", "/api/system/config")).status).toBe(401);
    expect((await call("GET", "/buncaster-events")).status).toBe(401);
    expect((await call("GET", "/api/stream/queue")).status).toBe(200);
    expect((await call("GET", "/api/health")).status).toBe(200);
    const ok = await call("POST", "/api/stream/skip", { authorization: `Bearer ${TOKEN}` });
    expect(ok.status).toBe(200);
    // Public listener mutations are not blocked by auth (404 here: live routes not mounted)
    expect((await call("POST", "/api/live/requests", {}, {})).status).not.toBe(401);
    expect((await call("POST", "/api/live/hearts", {}, {})).status).not.toBe(401);
  });

  test("login → cookie → access; logout clears; me reflects state", async () => {
    const { call } = makeRouter(TOKEN);
    const bad = await call("POST", "/api/studio/login", {}, { token: "nope" });
    expect(bad.status).toBe(401);
    const res = await call(
      "POST",
      "/api/studio/login",
      { "x-forwarded-proto": "https" },
      { token: TOKEN }
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toMatch(
      /^bloom_studio=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/
    );
    const cookie = setCookie.split(";")[0];
    expect((await call("POST", "/api/stream/skip", { cookie })).status).toBe(200);
    expect(await (await call("GET", "/api/studio/me", { cookie })).json()).toEqual({
      ok: true,
      data: { authenticated: true },
    });
    expect(await (await call("GET", "/api/studio/me")).json()).toEqual({
      ok: true,
      data: { authenticated: false },
    });
    const out = await call("POST", "/api/studio/logout", { cookie });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("brute-force guard: 11th failed login from one IP → 429", async () => {
    const { call } = makeRouter(TOKEN);
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 10; i++) {
      expect((await call("POST", "/api/studio/login", ip, { token: `x${i}` })).status).toBe(401);
    }
    const blocked = await call("POST", "/api/studio/login", ip, { token: TOKEN });
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBeGreaterThan(0);
    // other IPs unaffected
    expect((await call("POST", "/api/studio/login", {}, { token: TOKEN })).status).toBe(200);
  });

  test("DELETE /api/stream/queue/:rid decodes encodeURIComponent(rid) with slashes", async () => {
    const { call, queueRemove } = makeRouter(TOKEN);
    const rid = "music/songs/Artist - Song.mp3";
    const res = await call("DELETE", `/api/stream/queue/${encodeURIComponent(rid)}`, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
    expect(queueRemove.mock.calls.at(-1)?.[0]).toBe(rid);
    await call("DELETE", "/api/stream/queue/3", { authorization: `Bearer ${TOKEN}` });
    expect(queueRemove.mock.calls.at(-1)?.[0]).toBe("3");
  });
});

// ── Requests (pure) ───────────────────────────────────────────

describe("song requests — validation & limits", () => {
  test("sanitizeText trims, strips controls/bidi, collapses whitespace", () => {
    expect(sanitizeText("  Hola\u0000 ‮ mundo\n\t ")).toBe("Hola mundo");
    expect(sanitizeText("   ")).toBeNull();
    expect(sanitizeText(undefined)).toBeNull();
    expect(sanitizeText(5)).toBeNull();
  });

  test("containsUrl", () => {
    for (const s of [
      "https://x.y",
      "visit www.spam.net",
      "spam.com",
      "go to bit.ly/abc",
      "discord.gg/x",
    ]) {
      expect(containsUrl(s)).toBe(true);
    }
    for (const s of [
      "Para Ana, con cariño.",
      "feliz cumple!! 3.5 años",
      "Te quiero mucho. Gracias",
    ]) {
      expect(containsUrl(s)).toBe(false);
    }
  });

  test("validateRequestInput", () => {
    expect(validateRequestInput({ trackId: "abc", name: " Ana ", message: "Hola" })).toEqual({
      ok: true,
      value: { trackId: "abc", name: "Ana", message: "Hola" },
    });
    expect(validateRequestInput({ trackId: "abc" })).toEqual({
      ok: true,
      value: { trackId: "abc", name: null, message: null },
    });
    const bad = [
      null,
      [],
      {},
      { trackId: "" },
      { trackId: 5 },
      { trackId: "a b" },
      { trackId: "abc", name: "x".repeat(33) },
      { trackId: "abc", message: "x".repeat(141) },
      { trackId: "abc", name: 12 },
      { trackId: "abc", message: "mira www.spam.com" },
      { trackId: "abc", name: "spam.com" },
    ];
    for (const b of bad) expect(validateRequestInput(b).ok).toBe(false);
    // Limits count code points, not UTF-16 units
    expect(validateRequestInput({ trackId: "a", name: "🌸".repeat(32) }).ok).toBe(true);
  });

  test("checkRequestLimits order + retryAfter", () => {
    const now = 10_000_000;
    const base = {
      now,
      lastRequestFromIpAt: null,
      lastPlayedAt: null,
      alreadyRequested: false,
      pendingCount: 0,
    };
    expect(checkRequestLimits(base)).toEqual({ ok: true });
    expect(checkRequestLimits({ ...base, lastRequestFromIpAt: now - 60_000 })).toEqual({
      ok: false,
      error: "rate_limited",
      status: 429,
      retryAfter: 540,
    });
    expect(
      checkRequestLimits({ ...base, lastRequestFromIpAt: now - REQUEST_IP_COOLDOWN_MS }).ok
    ).toBe(true);
    expect(checkRequestLimits({ ...base, lastPlayedAt: now - 59 * 60_000 })).toMatchObject({
      error: "recently_played",
    });
    expect(checkRequestLimits({ ...base, lastPlayedAt: now - 61 * 60_000 }).ok).toBe(true);
    expect(checkRequestLimits({ ...base, alreadyRequested: true })).toMatchObject({
      error: "already_requested",
    });
    expect(checkRequestLimits({ ...base, pendingCount: 30 })).toMatchObject({
      error: "queue_full",
    });
    expect(checkRequestLimits({ ...base, pendingCount: 29 }).ok).toBe(true);
    expect(requestability(now - 1000, true, now)).toEqual({
      requestable: false,
      reason: "recently_played",
    });
    expect(requestability(null, true, now)).toEqual({
      requestable: false,
      reason: "already_requested",
    });
    expect(requestability(null, false, now)).toEqual({ requestable: true });
    expect(shouldAutoApprove(true, 2)).toBe(true);
    expect(shouldAutoApprove(true, 3)).toBe(false);
    expect(shouldAutoApprove(false, 0)).toBe(false);
  });

  test("selectPublicRequests: active + last 10 played, never rejected, newest first", () => {
    const row = (i: number, status: SongRequestRow["status"]): SongRequestRow => ({
      id: `r${String(i).padStart(3, "0")}`,
      trackId: "t",
      file: "songs/a.mp3",
      trackKey: "k",
      title: "T",
      artist: "A",
      name: null,
      message: null,
      status,
      ipHash: "h",
      createdAt: i * 1000,
      updatedAt: i * 1000,
      queuedAt: null,
      playedAt: null,
    });
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => row(i, "played")),
      row(20, "pending"),
      row(21, "rejected"),
      row(3, "queued"),
    ];
    const out = selectPublicRequests(rows);
    expect(out.some((r) => r.status === "rejected")).toBe(false);
    expect(out.filter((r) => r.status === "played")).toHaveLength(10);
    expect(out[0].id).toBe("r020");
    expect(out.map((r) => r.createdAt)).toEqual(
      [...out.map((r) => r.createdAt)].sort((a, b) => b - a)
    );
  });
});

// ── Requests (service + SQLite) ───────────────────────────────

function requestsFixture(opts: { autoApprove?: boolean; queueFiles?: string[] } = {}) {
  const db = new DatabaseConnection(":memory:");
  (db as any).createTables(); // idempotent migration
  const library = new LibraryRepository(db);
  const history = new PlayHistoryRepository(db);
  const repo = new SongRequestRepository(db);
  const songId = library.upsertTrack({
    file: "songs/Artist - Song.mp3",
    type: "song",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration: 200,
    size: 1,
    mtime: "",
  });
  const otherId = library.upsertTrack({
    file: "songs/Other - Tune.mp3",
    type: "song",
    title: "Tune",
    artist: "Other",
    duration: 100,
    size: 1,
    mtime: "",
  });
  const interId = library.upsertTrack({
    file: "interludios/x.mp3",
    type: "interludio",
    title: "Inter",
    duration: 10,
    size: 1,
    mtime: "",
  });
  const enqueued: string[] = [];
  const changes: unknown[][] = [];
  const service = new SongRequestsService({
    repo,
    libraryRepo: library,
    historyRepo: history,
    coverService: {
      register: (f: string) => fileTrackKey(f),
      coverUrlFor: (k: string) => `/api/live/cover/${k}`,
    },
    enqueueFile: async (f) => {
      enqueued.push(f);
      return true;
    },
    getQueueFiles: () => new Set(opts.queueFiles ?? []),
    ipSalt: "salt",
    autoApprove: opts.autoApprove ?? false,
    onPublicChange: (list) => changes.push(list),
  });
  return { db, library, history, repo, service, songId, otherId, interId, enqueued, changes };
}

describe("SongRequestsService", () => {
  test("create → pending; limits; approve enqueues directly; play marks played", async () => {
    const f = requestsFixture();
    const now = 50_000_000;
    const r1 = await f.service.create(
      { trackId: f.songId, name: "Ana", message: "Para ti" },
      "1.1.1.1",
      now
    );
    expect(r1).toMatchObject({ ok: true, status: "pending" });
    if (!r1.ok) throw new Error("unreachable");

    // same IP within 10 min
    const r2 = await f.service.create({ trackId: f.otherId }, "1.1.1.1", now + 60_000);
    expect(r2).toMatchObject({ ok: false, error: "rate_limited", status: 429, retryAfter: 540 });
    // other IP, same track → already requested
    expect(await f.service.create({ trackId: f.songId }, "2.2.2.2", now)).toMatchObject({
      error: "already_requested",
    });
    // interludios / unknown ids are not requestable
    expect(await f.service.create({ trackId: f.interId }, "3.3.3.3", now)).toMatchObject({
      error: "not_found",
      status: 404,
    });
    expect(await f.service.create({ trackId: "nope" }, "3.3.3.3", now)).toMatchObject({
      error: "not_found",
    });
    expect(
      await f.service.create({ trackId: f.otherId, message: "www.x.com" }, "3.3.3.3", now)
    ).toMatchObject({
      error: "invalid",
      status: 400,
    });

    // public list: no IP data
    const pub = f.service.listPublic();
    expect(pub).toHaveLength(1);
    expect(Object.keys(pub[0]).sort()).toEqual(
      ["artist", "coverUrl", "createdAt", "id", "message", "name", "status", "title"].sort()
    );
    expect(pub[0]).toMatchObject({
      title: "Song",
      artist: "Artist",
      name: "Ana",
      message: "Para ti",
    });
    expect(f.service.listStudio()[0].ipHash).toHaveLength(8);
    expect(f.changes.length).toBeGreaterThan(0);

    // approve → Buncaster (direct path), status queued
    const ap = await f.service.approve(r1.id, now + 1000);
    expect(ap.ok).toBe(true);
    expect(f.enqueued).toEqual(["/music/songs/Artist - Song.mp3"]);
    expect(f.repo.get(r1.id)?.status).toBe("queued");
    expect(await f.service.approve(r1.id)).toMatchObject({ error: "invalid_state" });

    // the poller sees it start
    expect(f.service.onTrackStart("music/songs/Artist - Song.mp3", now + 2000)).toEqual({
      name: "Ana",
      message: "Para ti",
    });
    expect(f.repo.get(r1.id)?.status).toBe("played");
    expect(f.service.onTrackStart("music/songs/Artist - Song.mp3", now + 3000)).toBeNull();
  });

  test("recently played (play history) and Buncaster queue block requests; search flags", async () => {
    const f = requestsFixture({ queueFiles: ["songs/Other - Tune.mp3"] });
    const now = 90_000_000;
    f.history.insert({
      trackKey: fileTrackKey("songs/Artist - Song.mp3"),
      file: "songs/Artist - Song.mp3",
      title: "Song",
      artist: "Artist",
      album: "",
      duration: 200,
      playedAt: now - 30 * 60_000,
    });
    expect(await f.service.create({ trackId: f.songId }, "4.4.4.4", now)).toMatchObject({
      error: "recently_played",
    });
    expect(await f.service.create({ trackId: f.otherId }, "4.4.4.4", now)).toMatchObject({
      error: "already_requested",
    });
    const results = f.service.search("song", "5", now);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: f.songId,
      title: "Song",
      album: "Album",
      duration: 200,
      requestable: false,
      reason: "recently_played",
    });
    expect(results[0].coverUrl).toBe(`/api/live/cover/${fileTrackKey("songs/Artist - Song.mp3")}`);
    expect(f.service.search("s", undefined, now)).toEqual([]); // min 2 chars
    expect(f.service.search("inter", undefined, now)).toEqual([]); // songs only
  });

  test("reject hides from public list; auto-approve while < 3 queued", async () => {
    const f = requestsFixture();
    const r = await f.service.create({ trackId: f.songId }, "5.5.5.5", 1000);
    if (!r.ok) throw new Error("create failed");
    expect((await f.service.reject(r.id)).ok).toBe(true);
    expect(f.service.listPublic()).toHaveLength(0);
    expect(f.service.listStudio()[0].status).toBe("rejected");

    const auto = requestsFixture({ autoApprove: true });
    const a = await auto.service.create({ trackId: auto.songId }, "6.6.6.6", 1000);
    expect(a).toMatchObject({ ok: true, status: "queued" });
    expect(auto.enqueued).toHaveLength(1);
  });

  test("studio enqueueTrack: direct path, not_found", async () => {
    const f = requestsFixture();
    expect(await f.service.enqueueTrack(f.otherId)).toEqual({ ok: true });
    expect(f.enqueued).toEqual(["/music/songs/Other - Tune.mp3"]);
    expect(await f.service.enqueueTrack("missing")).toMatchObject({
      error: "not_found",
      status: 404,
    });
    expect(await f.service.enqueueTrack(undefined)).toMatchObject({ error: "invalid" });
  });
});

// ── Hearts ────────────────────────────────────────────────────

describe("HeartsService", () => {
  test("one heart per IP per key; unknown/invalid keys rejected; emits throttled", async () => {
    const db = new DatabaseConnection(":memory:");
    const emitted: [string, number][] = [];
    const svc = new HeartsService({
      repo: new HeartsRepository(db),
      ipSalt: "salt",
      isKnownKey: (k) => k === "aaaaaaaaaaaa" || k === "bbbbbbbbbbbb",
      onCount: (key, count) => emitted.push([key, count]),
      throttleMs: 50,
    });
    expect(svc.heart("aaaaaaaaaaaa", "1.1.1.1")).toMatchObject({ ok: true, count: 1, added: true });
    expect(svc.heart("aaaaaaaaaaaa", "1.1.1.1")).toMatchObject({
      ok: true,
      count: 1,
      added: false,
    });
    expect(svc.heart("aaaaaaaaaaaa", "2.2.2.2")).toMatchObject({ ok: true, count: 2 });
    expect(svc.heart("bbbbbbbbbbbb", "1.1.1.1")).toMatchObject({ ok: true, count: 1 });
    expect(svc.heart("cccccccccccc", "1.1.1.1")).toMatchObject({ ok: false, error: "not_found" });
    expect(svc.heart("../etc", "1.1.1.1")).toMatchObject({ ok: false, error: "invalid" });
    expect(svc.counts(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "dddddddddddd"])).toEqual(
      new Map([
        ["aaaaaaaaaaaa", 2],
        ["bbbbbbbbbbbb", 1],
        ["dddddddddddd", 0],
      ])
    );
    // first heart per key emits immediately; the second one for "a" is deferred (throttle)
    expect(emitted).toEqual([
      ["aaaaaaaaaaaa", 1],
      ["bbbbbbbbbbbb", 1],
    ]);
    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.at(-1)).toEqual(["aaaaaaaaaaaa", 2]);
    svc.stop();
  });
});

// ── Reach + engine ────────────────────────────────────────────

describe("ReachService", () => {
  test("5-minute buckets keep the max and survive a restart", () => {
    const db = new DatabaseConnection(":memory:");
    const repo = new ListenerSamplesRepository(db);
    const reach = new ReachService(repo, () => 0);
    const t0 = bucketOf(Date.now()) - 2 * REACH_BUCKET_MS;
    reach.observe(3, t0 + 1000);
    reach.observe(1, t0 + 2000);
    reach.observe(5, t0 + REACH_BUCKET_MS + 10);
    expect(reach.series(t0 + 2 * REACH_BUCKET_MS)).toEqual([
      { t: t0, n: 3 },
      { t: t0 + REACH_BUCKET_MS, n: 5 },
    ]);
    const restarted = new ReachService(repo, () => 0);
    expect(restarted.series(t0 + 2 * REACH_BUCKET_MS)).toHaveLength(2);
    // older than 24h drops out
    expect(restarted.series(t0 + 25 * 60 * 60 * 1000)).toEqual([]);
  });

  test("mapEngineHealth", () => {
    expect(
      mapEngineHealth({
        status: "ok",
        uptime: 3043762.7,
        memory: { rss: 36 },
        nowPlaying: { isLive: false, type: "fallback" },
      })
    ).toEqual({ ok: true, uptimeSeconds: 3043762, rssMb: 36, live: false });
    expect(mapEngineHealth(null)).toEqual({
      ok: false,
      uptimeSeconds: 0,
      rssMb: null,
      live: false,
    });
    expect(mapEngineHealth({ status: "ok", nowPlaying: { isLive: true } }).live).toBe(true);
  });
});

// ── /status-json.xsl ──────────────────────────────────────────

describe("status-json mapping", () => {
  const now: any = {
    station: { name: "Bloom Radio", city: "Lima", timezone: "America/Lima" },
    track: { title: "Protect My Energy", artist: "Little Simz" },
    listeners: { current: 4, opus: 4, mp3: 0, peakToday: 9 },
    stream: { opus: "/radiobloom.opus", mp3: "/radiobloom.mp3", bitrateKbps: 192 },
  };

  test("Icecast shape", () => {
    const { host, origin } = publicOrigin(h({ "x-forwarded-host": "radio.example.org" }), true);
    expect(origin).toBe("https://radio.example.org");
    const s = buildIcecastStatus({ now, host, origin, streamStartMs: Date.UTC(2026, 9, 17) });
    expect(s).toEqual({
      icestats: {
        admin: "",
        host: "radio.example.org",
        location: "Lima, Perú",
        server_id: "Bloom Radio",
        source: {
          audio_info: "bitrate=192",
          bitrate: 192,
          genre: "Various",
          listener_peak: 9,
          listeners: 4,
          listenurl: "https://radio.example.org/radiobloom.opus",
          server_description: expect.any(String),
          server_name: "Bloom Radio",
          server_type: "audio/ogg",
          stream_start_iso8601: "2026-10-17T00:00:00.000Z",
          title: "Little Simz - Protect My Energy",
        },
      },
    });
  });

  test("host fallback + titles", () => {
    expect(publicOrigin(h({ host: "localhost:9876" }), false).origin).toBe("http://localhost:9876");
    expect(publicOrigin(h({ host: "evil<script>" }), false).host).toBe("185.139.1.222");
    expect(nowTitle({ ...now, track: null })).toBe("Bloom Radio");
    expect(nowTitle({ ...now, track: { title: "Solo", artist: "" } })).toBe("Solo");
  });
});
