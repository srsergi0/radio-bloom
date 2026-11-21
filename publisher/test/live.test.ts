import { describe, expect, test } from "bun:test";
import type { Locutor, LocutorSchedule, Track } from "../src/domain/types";
import { DatabaseConnection } from "../src/infrastructure/database";
import { PlayHistoryRepository } from "../src/repositories/sqlite/play-history.repo";
import {
  type BuncasterNowPlaying,
  buildNowPayload,
  computeListeners,
  expandScheduleSlots,
  fileTrackKey,
  findActiveHost,
  isValidTrackKey,
  limaClock,
  locutorNumericId,
  mapTrack,
  nowSignature,
  resolveSource,
  toLiveHost,
  truncatePersonality,
} from "../src/services/live.mapper";

// Monday 2026-11-23 10:30 in Lima (UTC-5)
const MON_1030_LIMA = Date.UTC(2026, 10, 23, 15, 30);
// Sunday 2026-11-22 23:59 in Lima
const SUN_2359_LIMA = Date.UTC(2026, 10, 23, 4, 59);

const loc = (id: string, over: Partial<Locutor> = {}): Locutor => ({
  id,
  name: `Host ${id}`,
  voice: "es-PE-CamilaNeural",
  personality: "Alegre",
  isActive: true,
  isDefault: false,
  ...over,
});

const sch = (over: Partial<LocutorSchedule> & { locutorId: string }): LocutorSchedule => ({
  id: `sch_${Math.random()}`,
  type: "weekly",
  dayOfWeek: 1,
  startHour: "06:00",
  duration: 60,
  ...over,
});

describe("live.mapper — time & ids", () => {
  test("limaClock returns Lima weekday/minute", () => {
    expect(limaClock(MON_1030_LIMA)).toEqual({
      dayOfWeek: 1,
      minute: 630,
      dateKey: "2026-11-23",
    });
    expect(limaClock(SUN_2359_LIMA)).toMatchObject({ dayOfWeek: 0, minute: 1439 });
  });

  test("keys are stable, short and path-form independent", () => {
    const a = fileTrackKey("music/songs/Artist - Song.flac");
    const b = fileTrackKey("songs/Artist - Song.flac");
    const c = fileTrackKey("/app/music/songs/Artist - Song.flac");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(isValidTrackKey(a)).toBe(true);
    expect(fileTrackKey("songs/Other.mp3")).not.toBe(a);
  });

  test("locutorNumericId is a stable positive integer", () => {
    const id = locutorNumericId("loc_1783_abc");
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThan(0);
    expect(locutorNumericId("loc_1783_abc")).toBe(id);
    expect(locutorNumericId("42")).toBe(42);
  });

  test("truncatePersonality cuts near 180 chars on a word boundary", () => {
    const long = "palabra ".repeat(60);
    const out = truncatePersonality(long);
    expect(out.length).toBeLessThanOrEqual(181);
    expect(out.endsWith("…")).toBe(true);
    expect(truncatePersonality("Corta")).toBe("Corta");
  });
});

describe("live.mapper — schedule expansion", () => {
  test("daily schedules expand to 7 days, weekly to 1; sorted by day/start", () => {
    const locutors = [loc("a", { isDefault: true }), loc("b"), loc("off", { isActive: false })];
    const schedules = [
      sch({ locutorId: "b", type: "weekly", dayOfWeek: 3, startHour: "18:00", duration: 180 }),
      sch({ locutorId: "a", type: "daily", dayOfWeek: null, startHour: "6:00", duration: 360 }),
      sch({ locutorId: "off", type: "daily", dayOfWeek: null, startHour: "00:00", duration: 60 }),
    ];
    const slots = expandScheduleSlots(locutors, schedules);

    expect(slots).toHaveLength(8); // 7 daily (a) + 1 weekly (b); inactive skipped
    expect(slots.map((s) => s.dayOfWeek)).toEqual([0, 1, 2, 3, 3, 4, 5, 6]);
    expect(slots[0]).toEqual({
      locutorId: locutorNumericId("a"),
      hostName: "Host a",
      voice: "es-PE-CamilaNeural",
      personality: "Alegre",
      dayOfWeek: 0,
      start: "06:00", // normalised HH:MM
      duration: 360,
      isDefault: true,
    });
    const wed = slots.filter((s) => s.dayOfWeek === 3);
    expect(wed.map((s) => s.start)).toEqual(["06:00", "18:00"]);
    expect(wed[1].isDefault).toBe(false);
  });

  test("findActiveHost picks the covering slot and computes endsAt", () => {
    const locutors = [loc("a"), loc("b")];
    const schedules = [
      sch({ locutorId: "a", type: "weekly", dayOfWeek: 1, startHour: "06:00", duration: 360 }),
      sch({ locutorId: "b", type: "weekly", dayOfWeek: 1, startHour: "12:00", duration: 120 }),
    ];
    const found = findActiveHost(locutors, schedules, MON_1030_LIMA);
    expect(found?.locutor.id).toBe("a");
    expect(found?.show).toEqual({
      start: "06:00",
      duration: 360,
      endsAt: Date.UTC(2026, 10, 23, 17, 0), // 12:00 Lima
    });
    const host = toLiveHost(found);
    expect(host?.id).toBe(locutorNumericId("a"));
  });

  test("findActiveHost handles slots wrapping past midnight / week end", () => {
    const locutors = [loc("n")];
    // Sunday 23:00 for 120 min → covers Sunday 23:59
    const schedules = [
      sch({ locutorId: "n", type: "weekly", dayOfWeek: 0, startHour: "23:00", duration: 120 }),
    ];
    const found = findActiveHost(locutors, schedules, SUN_2359_LIMA);
    expect(found?.show?.start).toBe("23:00");
    expect(found?.show?.endsAt).toBe(Date.UTC(2026, 10, 23, 6, 0)); // Mon 01:00 Lima
  });

  test("findActiveHost falls back to default locutor with show=null, else null", () => {
    const schedules = [sch({ locutorId: "x", dayOfWeek: 5 })];
    const withDefault = findActiveHost(
      [loc("x"), loc("d", { isDefault: true })],
      schedules,
      MON_1030_LIMA
    );
    expect(withDefault?.locutor.id).toBe("d");
    expect(withDefault?.show).toBeNull();
    expect(findActiveHost([loc("x")], schedules, MON_1030_LIMA)).toBeNull();
    expect(findActiveHost([], [], MON_1030_LIMA)).toBeNull();
  });
});

describe("live.mapper — now payload", () => {
  const np: BuncasterNowPlaying = {
    type: "fallback",
    isLive: false,
    title: "DtMF",
    artist: "Bad Bunny",
    file: "music/songs/Bad Bunny - Album/16 - DtMF.flac",
    duration: 237.1,
    elapsed: 63.7,
    startedAt: 1_000_000,
  };
  const lib: Track = {
    id: "local_1",
    type: "song",
    file: "songs/Bad Bunny - Album/16 - DtMF.flac",
    title: "Wrong Title From Filename",
    artist: "",
    album: "DeBÍ TiRAR MáS FOToS",
    duration: 237,
    spotifyUrl: "https://open.spotify.com/track/abc",
    addedAt: "",
  };

  test("title/artist come from Buncaster, album/spotify from library", () => {
    const t = mapTrack(np, { library: lib, coverUrl: "/api/live/cover/x", now: 2_000_000 });
    expect(t).toEqual({
      key: fileTrackKey("songs/Bad Bunny - Album/16 - DtMF.flac"),
      title: "DtMF",
      artist: "Bad Bunny",
      album: "DeBÍ TiRAR MáS FOToS",
      duration: 237.1,
      elapsed: 0,
      startedAt: 1_000_000,
      coverUrl: "/api/live/cover/x",
      spotifyUrl: "https://open.spotify.com/track/abc",
      type: "song",
    });
  });

  test("junk spotify_url values from tags are dropped", () => {
    const t = mapTrack(np, {
      library: { ...lib, spotifyUrl: "www.SongsLover.com" },
      coverUrl: null,
      now: 0,
    });
    expect(t?.spotifyUrl).toBeNull();
  });

  test("library-less track gives null album/spotifyUrl", () => {
    const t = mapTrack(np, { library: null, coverUrl: null, now: 0 });
    expect(t?.album).toBeNull();
    expect(t?.spotifyUrl).toBeNull();
  });

  test("ai_dj_ files are interludios without cover", () => {
    const t = mapTrack(
      {
        ...np,
        file: "music/interludios/ai_dj_pl_123_ab.mp3",
        title: "ai_dj_pl_123_ab",
        artist: "",
      },
      { library: null, coverUrl: "/api/live/cover/x", hostName: "Aurora", now: 0 }
    );
    expect(t?.type).toBe("interludio");
    expect(t?.title).toBe("Interludio");
    expect(t?.artist).toBe("Aurora");
    expect(t?.coverUrl).toBeNull();
  });

  test("silence → null track; live → keyed by title+artist and liveSince", () => {
    expect(
      mapTrack({ ...np, type: "silence", file: null }, { library: null, coverUrl: null, now: 0 })
    ).toBeNull();
    const live = mapTrack(
      {
        ...np,
        type: "live",
        isLive: true,
        file: null,
        title: "Transmisión en Vivo",
        artist: "OBS Studio",
      },
      { library: null, coverUrl: null, liveSince: 5000, now: 9000 }
    );
    expect(live?.startedAt).toBe(5000);
    expect(live?.coverUrl).toBeNull();
    expect(isValidTrackKey(live!.key)).toBe(true);
    expect(resolveSource({ ...np, isLive: true, type: "live" }, true)).toBe("live");
    expect(resolveSource(np, true)).toBe("queue");
    expect(resolveSource(np, false)).toBe("autodj");
  });

  test("listeners subtract the publisher's own upstream connection", () => {
    expect(
      computeListeners({
        buncasterOpus: 1,
        buncasterMp3: 0,
        localOpus: 7,
        localMp3: 0,
        opusUpstream: true,
        mp3Upstream: false,
      })
    ).toEqual({ current: 7, opus: 7, mp3: 0 });
    expect(
      computeListeners({
        buncasterOpus: 3,
        buncasterMp3: 2,
        localOpus: 1,
        localMp3: 1,
        opusUpstream: true,
        mp3Upstream: true,
      })
    ).toEqual({ current: 5, opus: 3, mp3: 2 });
  });

  test("buildNowPayload fills elapsed at serverTime, caps upNext at 5, has exact keys", () => {
    const track = mapTrack(np, { library: lib, coverUrl: null, now: 0 });
    const state = {
      isLive: false,
      source: "autodj" as const,
      track,
      host: null,
      listeners: { current: 2, opus: 2, mp3: 0, peakToday: 4 },
      stream: { opus: "/radiobloom.opus", mp3: "/radiobloom.mp3", bitrateKbps: 192 },
      upNext: Array.from({ length: 8 }, (_, i) => ({
        title: `T${i}`,
        artist: "A",
        type: "song" as const,
        coverUrl: null,
      })),
    };
    const p = buildNowPayload(state, 1_000_000 + 63_700);
    expect(Object.keys(p).sort()).toEqual(
      ["host", "listeners", "onAir", "serverTime", "station", "stream", "track", "upNext"].sort()
    );
    expect(p.station).toEqual({ name: "Bloom Radio", city: "Lima", timezone: "America/Lima" });
    expect(p.onAir).toEqual({ isLive: false, source: "autodj" });
    expect(p.track?.elapsed).toBe(63.7);
    expect(p.upNext).toHaveLength(5);
    expect(p.serverTime).toBe(1_063_700);
    // Elapsed clamps to duration
    expect(buildNowPayload(state, 1_000_000 + 999_000).track?.elapsed).toBe(237.1);
    // Signature ignores elapsed/listeners but tracks the key
    expect(nowSignature(state)).toBe(
      nowSignature({ ...state, listeners: { ...state.listeners, current: 9 } })
    );
    expect(nowSignature(state)).not.toBe(nowSignature({ ...state, track: null }));
  });
});

describe("PlayHistoryRepository", () => {
  test("migration is idempotent; list newest first; prunes to max rows", () => {
    const db = new DatabaseConnection(":memory:");
    // Running the migrations again on the same connection must not throw
    (db as any).createTables();
    const repo = new PlayHistoryRepository(db, 3);
    for (let i = 1; i <= 5; i++) {
      repo.insert({
        trackKey: `k${i}`,
        file: `songs/${i}.mp3`,
        title: `Song ${i}`,
        artist: "A",
        album: "",
        duration: 100,
        playedAt: i * 1000,
      });
    }
    const rows = repo.list(10);
    expect(rows.map((r) => r.title)).toEqual(["Song 5", "Song 4", "Song 3"]);
    expect(repo.latest()?.trackKey).toBe("k5");
    expect(repo.findFileByKey("k4")).toBe("songs/4.mp3");
    expect(repo.findFileByKey("k1")).toBeNull();
  });
});
