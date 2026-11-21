/**
 * Pure helpers for the public listener API (/api/live/*).
 * No I/O here: everything is a function of its inputs so it can be unit-tested.
 */
import { createHash } from "node:crypto";
import type {
  LiveHost,
  LiveListeners,
  LiveNowPayload,
  LiveScheduleSlot,
  LiveShow,
  LiveSource,
  LiveStreamInfo,
  LiveTrack,
  LiveUpNextItem,
  Locutor,
  LocutorSchedule,
  Track,
} from "../domain/types";
import { toDbPath } from "./buncaster.service";

export const LIVE_TIMEZONE = "America/Lima";
export const STATION = { name: "Bloom Radio", city: "Lima", timezone: LIVE_TIMEZONE } as const;
export const PERSONALITY_MAX_CHARS = 180;
export const COVER_ROUTE_PREFIX = "/api/live/cover/";
const WEEK_MINUTES = 7 * 1440;

/** nowPlaying as reported by Buncaster GET /status. */
export interface BuncasterNowPlaying {
  type: "fallback" | "live" | "silence" | string;
  isLive: boolean;
  title: string;
  artist: string;
  file: string | null;
  duration: number;
  elapsed: number;
  startedAt: number | null;
}

// ── Keys & paths ────────────────────────────────────────────

export { toDbPath };

/** Stable short hash (12 hex chars). Same input → same key, across restarts. */
export function hashKey(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

/** Key for a file reported by Buncaster ("music/songs/..") or the library ("songs/.."). */
export function fileTrackKey(file: string): string {
  return hashKey(toDbPath(file));
}

export function liveTrackKey(title: string, artist: string): string {
  return hashKey(`live:${title}|${artist}`);
}

export function isValidTrackKey(key: string): boolean {
  return /^[a-f0-9]{12}$/.test(key);
}

export function coverUrlForKey(key: string): string {
  return `${COVER_ROUTE_PREFIX}${key}`;
}

export function isInterludioFile(file: string): boolean {
  const db = toDbPath(file);
  const base = db.split("/").pop() || "";
  return db.startsWith("interludios/") || base.startsWith("ai_dj_");
}

/** FNV-1a 32-bit → stable positive integer id for string locutor ids ("loc_..."). */
export function locutorNumericId(id: string): number {
  if (/^\d+$/.test(id)) return Number(id);
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function truncatePersonality(text: string, max = PERSONALITY_MAX_CHARS): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s,.;:—-]+$/, "")}…`;
}

// ── Time (America/Lima) ────────────────────────────────────

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const limaFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: LIVE_TIMEZONE,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface LimaClock {
  dayOfWeek: number; // 0-6, Sunday = 0
  minute: number; // 0-1439
  dateKey: string; // YYYY-MM-DD in Lima (used to reset daily counters)
}

export function limaClock(nowMs: number): LimaClock {
  const parts: Record<string, string> = {};
  for (const p of limaFormatter.formatToParts(new Date(nowMs))) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return {
    dayOfWeek: WEEKDAYS[parts.weekday] ?? 0,
    minute: hour * 60 + Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function formatHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ── Schedule ───────────────────────────────────────────────

/** Expands daily schedules into 7 weekly slots; only active locutors. Sorted by day/start. */
export function expandScheduleSlots(
  locutors: Locutor[],
  schedules: LocutorSchedule[]
): LiveScheduleSlot[] {
  const byId = new Map(locutors.filter((l) => l.isActive).map((l) => [l.id, l]));
  const slots: LiveScheduleSlot[] = [];
  for (const sch of schedules) {
    const loc = byId.get(sch.locutorId);
    if (!loc) continue;
    const days =
      sch.type === "daily" ? [0, 1, 2, 3, 4, 5, 6] : [Math.min(6, Math.max(0, sch.dayOfWeek ?? 0))];
    const start = formatHHMM(parseHHMM(sch.startHour));
    for (const dayOfWeek of days) {
      slots.push({
        locutorId: locutorNumericId(loc.id),
        hostName: loc.name,
        voice: loc.voice,
        personality: truncatePersonality(loc.personality),
        dayOfWeek,
        start,
        duration: sch.duration,
        isDefault: loc.isDefault,
      });
    }
  }
  slots.sort(
    (a, b) =>
      a.dayOfWeek - b.dayOfWeek ||
      a.start.localeCompare(b.start) ||
      a.hostName.localeCompare(b.hostName)
  );
  return slots;
}

/**
 * Active locutor at `nowMs` (Lima time). Same rules as LocutorService.getActiveLocutorAtCurrentTime:
 * first schedule of an active locutor covering now wins; otherwise the default active locutor
 * (show = null); otherwise null.
 */
export function findActiveHost(
  locutors: Locutor[],
  schedules: LocutorSchedule[],
  nowMs: number
): { locutor: Locutor; show: LiveShow | null } | null {
  const active = new Map(locutors.filter((l) => l.isActive).map((l) => [l.id, l]));
  if (active.size === 0) return null;

  const clock = limaClock(nowMs);
  const minuteFloorMs = Math.floor(nowMs / 60000) * 60000; // Lima offset is whole hours
  const weeklyNow = clock.dayOfWeek * 1440 + clock.minute;

  for (const sch of schedules) {
    const loc = active.get(sch.locutorId);
    if (!loc) continue;
    const startMin = parseHHMM(sch.startHour);
    const diff =
      sch.type === "daily"
        ? (clock.minute - startMin + 1440) % 1440
        : (weeklyNow - ((sch.dayOfWeek ?? 0) * 1440 + startMin) + WEEK_MINUTES) % WEEK_MINUTES;
    if (diff < sch.duration) {
      const startedAt = minuteFloorMs - diff * 60000;
      return {
        locutor: loc,
        show: {
          start: formatHHMM(startMin),
          duration: sch.duration,
          endsAt: startedAt + sch.duration * 60000,
        },
      };
    }
  }

  for (const loc of active.values()) {
    if (loc.isDefault) return { locutor: loc, show: null };
  }
  return null;
}

export function toLiveHost(
  found: { locutor: Locutor; show: LiveShow | null } | null
): LiveHost | null {
  if (!found) return null;
  const { locutor, show } = found;
  return {
    id: locutorNumericId(locutor.id),
    name: locutor.name,
    voice: locutor.voice,
    personality: truncatePersonality(locutor.personality),
    show,
  };
}

// ── Track ──────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Library spotify_url sometimes holds junk from file tags (e.g. "www.SongsLover.com"). */
export function sanitizeSpotifyUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\/open\.spotify\.com\/[a-z]+\/[A-Za-z0-9]+/.test(url) ? url : null;
}

export interface MapTrackOptions {
  library: Track | null;
  coverUrl: string | null;
  /** When live, the epoch ms at which we first observed the live session. */
  liveSince?: number | null;
  hostName?: string | null;
  now: number;
}

/**
 * Maps Buncaster's nowPlaying (authoritative title/artist/timing) + the library row
 * (album, spotifyUrl) to the public track shape. Returns null on silence / nothing playing.
 */
export function mapTrack(np: BuncasterNowPlaying | null, opts: MapTrackOptions): LiveTrack | null {
  if (!np || np.type === "silence") return null;

  if (np.isLive || np.type === "live") {
    const title = np.title || "Transmisión en Vivo";
    const artist = np.artist || "";
    return {
      key: liveTrackKey(title, artist),
      title,
      artist,
      album: null,
      duration: 0,
      elapsed: 0,
      startedAt: opts.liveSince ?? opts.now,
      coverUrl: null,
      spotifyUrl: null,
      type: "song",
    };
  }

  if (!np.file) return null;
  const lib = opts.library;
  const interludio = isInterludioFile(np.file) || lib?.type === "interludio";
  const fileBase = (np.file.split("/").pop() || "").replace(/\.[^.]+$/, "");

  let title = (np.title || "").trim() || lib?.title || fileBase;
  let artist = (np.artist || "").trim() || lib?.artist || "";
  if (interludio && (!title || title.startsWith("ai_dj_") || title === fileBase)) {
    title = "Interludio";
    artist = artist || opts.hostName || STATION.name;
  }

  const duration = round1(np.duration > 0 ? np.duration : lib?.duration || 0);
  return {
    key: fileTrackKey(np.file),
    title,
    artist,
    album: lib?.album ? lib.album : null,
    duration,
    elapsed: 0,
    startedAt: np.startedAt ?? opts.now,
    coverUrl: interludio ? null : opts.coverUrl,
    spotifyUrl: sanitizeSpotifyUrl(lib?.spotifyUrl),
    type: interludio ? "interludio" : "song",
  };
}

/** Recomputes `elapsed` for the given server time (clamped to [0, duration] when known). */
export function withElapsed(track: LiveTrack | null, now: number): LiveTrack | null {
  if (!track) return null;
  let elapsed = Math.max(0, (now - track.startedAt) / 1000);
  if (track.duration > 0) elapsed = Math.min(elapsed, track.duration);
  return { ...track, elapsed: round1(elapsed) };
}

export function resolveSource(
  np: BuncasterNowPlaying | null,
  playedFromQueue: boolean
): LiveSource {
  if (np && (np.isLive || np.type === "live")) return "live";
  return playedFromQueue ? "queue" : "autodj";
}

// ── Listeners ──────────────────────────────────────────────

export interface ListenerInputs {
  /** Buncaster /status counts (include the publisher's own upstream connections). */
  buncasterOpus: number;
  buncasterMp3: number;
  /** Clients attached to the publisher's StreamBroadcasters (/radiobloom.*). */
  localOpus: number;
  localMp3: number;
  /** Whether each publisher broadcaster currently holds an upstream connection to Buncaster. */
  opusUpstream: boolean;
  mp3Upstream: boolean;
}

/**
 * Real audience = publisher proxy clients + direct Buncaster clients
 * (Buncaster's count minus the publisher's own upstream connection per tier).
 */
export function computeListeners(i: ListenerInputs): Omit<LiveListeners, "peakToday"> {
  const opus = i.localOpus + Math.max(0, i.buncasterOpus - (i.opusUpstream ? 1 : 0));
  const mp3 = i.localMp3 + Math.max(0, i.buncasterMp3 - (i.mp3Upstream ? 1 : 0));
  return { current: opus + mp3, opus, mp3 };
}

// ── Payload ────────────────────────────────────────────────

export interface LiveStateSnapshot {
  isLive: boolean;
  source: LiveSource;
  track: LiveTrack | null;
  host: LiveHost | null;
  listeners: LiveListeners;
  stream: LiveStreamInfo;
  upNext: LiveUpNextItem[];
}

export function buildNowPayload(state: LiveStateSnapshot, now: number): LiveNowPayload {
  return {
    station: { ...STATION },
    onAir: { isLive: state.isLive, source: state.source },
    track: withElapsed(state.track, now),
    host: state.host,
    listeners: { ...state.listeners },
    stream: { ...state.stream },
    upNext: state.upNext.slice(0, 5),
    serverTime: now,
  };
}

/** Fields whose change must push an `event: now` to SSE subscribers. */
export function nowSignature(state: LiveStateSnapshot): string {
  const h = state.host;
  return JSON.stringify([
    state.track?.key ?? null,
    state.track?.startedAt ?? null,
    state.track?.coverUrl ?? null,
    state.isLive,
    state.source,
    h ? [h.id, h.show?.start ?? null, h.show?.endsAt ?? null] : null,
    state.upNext.map((u) => [u.title, u.artist, u.type, u.coverUrl]),
  ]);
}
