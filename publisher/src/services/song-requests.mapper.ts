/**
 * Pure helpers for listener song requests ("pedidos") — validation, limits, public mapping.
 * No I/O: the service feeds in the facts (last request time, play history, pending count...).
 */

export type SongRequestStatus = "pending" | "queued" | "played" | "rejected";
export type RequestErrorCode =
  | "rate_limited"
  | "recently_played"
  | "already_requested"
  | "queue_full"
  | "not_found"
  | "invalid";

export const REQUEST_NAME_MAX = 32;
export const REQUEST_MESSAGE_MAX = 140;
export const REQUEST_IP_COOLDOWN_MS = 10 * 60 * 1000;
export const REQUEST_RECENT_PLAY_MS = 60 * 60 * 1000;
export const REQUEST_MAX_PENDING = 30;
export const REQUEST_AUTO_APPROVE_MAX_QUEUED = 3;
export const PUBLIC_PLAYED_LIMIT = 10;

export interface SongRequestRow {
  id: string;
  trackId: string;
  file: string;
  trackKey: string;
  title: string;
  artist: string;
  name: string | null;
  message: string | null;
  status: SongRequestStatus;
  ipHash: string;
  createdAt: number;
  updatedAt: number;
  queuedAt: number | null;
  playedAt: number | null;
}

export interface PublicRequestItem {
  id: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  name: string | null;
  message: string | null;
  status: SongRequestStatus;
  createdAt: number;
}

export interface StudioRequestItem extends PublicRequestItem {
  trackId: string;
  ipHash: string;
  updatedAt: number;
}

// ── Text sanitising ────────────────────────────────────────

// C0/C1 controls, zero-width chars and bidi overrides (used to spoof text direction)
function isControlOrInvisible(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) || // zero-width + LRM/RLM
    (cp >= 0x202a && cp <= 0x202e) || // bidi embeddings/overrides
    (cp >= 0x2060 && cp <= 0x2069) || // word joiner + bidi isolates
    cp === 0xfeff
  );
}

function stripControls(s: string): string {
  let out = "";
  for (const ch of s) out += isControlOrInvisible(ch.codePointAt(0) ?? 0) ? " " : ch;
  return out;
}

/** Trim, strip control/invisible chars, collapse whitespace. Empty → null. */
export function sanitizeText(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") return null;
  const clean = stripControls(input).replace(/\s+/g, " ").trim();
  return clean.length ? clean : null;
}

const URL_RE =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|me|ly|gg|tv|xyz|info|biz|app|dev|link|site|online|top|ru|cn|tk|pe|es|ar|mx|cl|us|uk|de|fr|br|to|sh|cc|ai|be|fm|club|shop|store|live|stream)\b(?:\/|$|\s|[?#:]))/i;

export function containsUrl(text: string): boolean {
  return URL_RE.test(text);
}

const codePoints = (s: string) => [...s].length;

export interface ValidatedRequestInput {
  trackId: string;
  name: string | null;
  message: string | null;
}

/** Validates the POST /api/live/requests body. */
export function validateRequestInput(
  body: unknown
): { ok: true; value: ValidatedRequestInput } | { ok: false; error: "invalid"; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid", detail: "body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const trackId = typeof b.trackId === "string" ? b.trackId.trim() : "";
  if (!trackId || trackId.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(trackId)) {
    return { ok: false, error: "invalid", detail: "trackId" };
  }
  for (const field of ["name", "message"] as const) {
    const v = b[field];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return { ok: false, error: "invalid", detail: field };
    }
  }
  const name = sanitizeText(b.name);
  const message = sanitizeText(b.message);
  if (name && codePoints(name) > REQUEST_NAME_MAX) {
    return { ok: false, error: "invalid", detail: "name too long" };
  }
  if (message && codePoints(message) > REQUEST_MESSAGE_MAX) {
    return { ok: false, error: "invalid", detail: "message too long" };
  }
  if ((name && containsUrl(name)) || (message && containsUrl(message))) {
    return { ok: false, error: "invalid", detail: "links are not allowed" };
  }
  return { ok: true, value: { trackId, name, message } };
}

// ── Limits ─────────────────────────────────────────────────

export interface RequestFacts {
  now: number;
  /** createdAt of the newest stored request from this IP hash (any status), or null. */
  lastRequestFromIpAt: number | null;
  /** Last time this track started playing (play history), or null. */
  lastPlayedAt: number | null;
  /** Track already pending/queued as a request, or sitting in Buncaster's queue. */
  alreadyRequested: boolean;
  pendingCount: number;
}

export type LimitResult =
  | { ok: true }
  | { ok: false; error: RequestErrorCode; status: number; retryAfter?: number };

/** Order: per-IP cooldown → recently played → already requested → global cap. */
export function checkRequestLimits(f: RequestFacts): LimitResult {
  if (f.lastRequestFromIpAt !== null && f.now - f.lastRequestFromIpAt < REQUEST_IP_COOLDOWN_MS) {
    const retryAfter = Math.max(
      1,
      Math.ceil((f.lastRequestFromIpAt + REQUEST_IP_COOLDOWN_MS - f.now) / 1000)
    );
    return { ok: false, error: "rate_limited", status: 429, retryAfter };
  }
  if (f.lastPlayedAt !== null && f.now - f.lastPlayedAt < REQUEST_RECENT_PLAY_MS) {
    return { ok: false, error: "recently_played", status: 409 };
  }
  if (f.alreadyRequested) return { ok: false, error: "already_requested", status: 409 };
  if (f.pendingCount >= REQUEST_MAX_PENDING) return { ok: false, error: "queue_full", status: 409 };
  return { ok: true };
}

/** Search-result flag (same rules, minus the per-IP/global ones). */
export function requestability(
  lastPlayedAt: number | null,
  alreadyRequested: boolean,
  now: number
): { requestable: boolean; reason?: "recently_played" | "already_requested" } {
  if (lastPlayedAt !== null && now - lastPlayedAt < REQUEST_RECENT_PLAY_MS) {
    return { requestable: false, reason: "recently_played" };
  }
  if (alreadyRequested) return { requestable: false, reason: "already_requested" };
  return { requestable: true };
}

export function shouldAutoApprove(enabled: boolean, queuedCount: number): boolean {
  return enabled && queuedCount < REQUEST_AUTO_APPROVE_MAX_QUEUED;
}

// ── Public mapping ─────────────────────────────────────────

export function toPublicRequest(r: SongRequestRow, coverUrl: string | null): PublicRequestItem {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    coverUrl,
    name: r.name,
    message: r.message,
    status: r.status,
    createdAt: r.createdAt,
  };
}

export function toStudioRequest(
  r: SongRequestRow,
  coverUrl: string | null
): StudioRequestItem & {
  ipHash: string;
} {
  return {
    ...toPublicRequest(r, coverUrl),
    trackId: r.trackId,
    ipHash: r.ipHash.slice(0, 8),
    updatedAt: r.updatedAt,
  };
}

/**
 * Public list: pending + queued, plus the last N played; never rejected; newest first.
 * `rows` may be in any order.
 */
export function selectPublicRequests(
  rows: SongRequestRow[],
  playedLimit = PUBLIC_PLAYED_LIMIT
): SongRequestRow[] {
  const byNewest = [...rows].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const active = byNewest.filter((r) => r.status === "pending" || r.status === "queued");
  const played = byNewest.filter((r) => r.status === "played").slice(0, playedLimit);
  return [...active, ...played].sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)
  );
}
