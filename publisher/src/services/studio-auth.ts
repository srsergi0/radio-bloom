/**
 * Studio auth: protects the control API (skip, queue, library, torrents, admin proxies...).
 * Pure helpers (no I/O) so the whole access matrix is unit-testable.
 *
 *  - Credential: `Authorization: Bearer <STUDIO_TOKEN>` or the `bloom_studio` session cookie
 *    (HMAC-signed with STUDIO_SESSION_SECRET, 30-day expiry, obtained via POST /api/studio/login).
 *  - STUDIO_TOKEN unset → everything stays open (backward compat) + loud startup warning.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "bloom_studio";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// ── Client IP ──────────────────────────────────────────────

type HeaderGetter = { get(name: string): string | null };

/** cf-connecting-ip → x-real-ip → first of x-forwarded-for → socket address. */
export function clientIpFrom(headers: HeaderGetter, socketIp?: string | null): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  return socketIp || "unknown";
}

/** True when the original request (before Cloudflare/nginx) was HTTPS. */
export function isHttpsRequest(headers: HeaderGetter): boolean {
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;
  const visitor = headers.get("cf-visitor") || "";
  return /"scheme"\s*:\s*"https"/i.test(visitor);
}

/** Salted hash of an IP (never store raw IPs). */
export function hashIp(ip: string, salt: string): string {
  return createHmac("sha256", `bloom-ip:${salt}`).update(ip).digest("hex");
}

// ── Token & session ────────────────────────────────────────

/** Constant-time comparison (hashes both sides so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Session value: `<expiresAtMs>.<nonce>.<hmac>` */
export function createSession(
  secret: string,
  now = Date.now()
): { value: string; expiresAt: number } {
  const expiresAt = now + SESSION_TTL_MS;
  const payload = `${expiresAt}.${randomBytes(12).toString("base64url")}`;
  return { value: `${payload}.${sign(payload, secret)}`, expiresAt };
}

export function verifySession(
  value: string | null | undefined,
  secret: string,
  now = Date.now()
): boolean {
  if (!value || value.length > 256) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, mac] = parts;
  if (!/^\d{10,16}$/.test(exp) || !nonce) return false;
  if (!safeEqual(mac, sign(`${exp}.${nonce}`, secret))) return false;
  return Number(exp) > now;
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function buildSessionCookie(
  value: string,
  opts: { secure: boolean; maxAgeSeconds: number }
): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
  ];
  if (opts.maxAgeSeconds <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export interface StudioAuthConfig {
  /** STUDIO_TOKEN; empty/undefined → auth disabled (everything open). */
  token?: string | null;
  /** STUDIO_SESSION_SECRET; falls back to a key derived from the token. */
  sessionSecret?: string | null;
}

export function resolveSessionSecret(cfg: StudioAuthConfig): string {
  if (cfg.sessionSecret) return cfg.sessionSecret;
  return createHmac("sha256", "bloom-studio-session")
    .update(cfg.token || "")
    .digest("hex");
}

/** Is the request authenticated? (Bearer token or valid session cookie.) */
export function isAuthenticated(
  headers: HeaderGetter,
  cfg: StudioAuthConfig,
  now = Date.now()
): boolean {
  const token = cfg.token;
  if (!token) return false;
  const auth = headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && safeEqual(m[1].trim(), token)) return true;
  const cookie = parseCookies(headers.get("cookie"))[SESSION_COOKIE];
  return verifySession(cookie, resolveSessionSecret(cfg), now);
}

// ── Access matrix ──────────────────────────────────────────

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Mutations that stay public (listeners). Keys are `METHOD path`. */
const PUBLIC_MUTATIONS = new Set([
  "POST /api/studio/login",
  "POST /api/live/requests",
  "POST /api/live/hearts",
]);

/** Normalises a path the same way for matching: decoded, lowercase, no dup/trailing slashes. */
export function normalizePath(path: string): string {
  let p = path;
  try {
    p = decodeURIComponent(p);
  } catch {}
  p = p
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/** Does `METHOD path` require studio auth? (Independent of whether a token is configured.) */
export function requiresStudioAuth(method: string, rawPath: string): boolean {
  const m = method.toUpperCase();
  const p = normalizePath(rawPath);
  if (m === "OPTIONS") return false; // CORS preflight

  // Admin proxies: every method
  if (p === "/buncaster-admin" || p.startsWith("/buncaster-admin/")) return true;
  if (p === "/buncaster-events" || p.startsWith("/buncaster-events/")) return true;
  if (p.startsWith("/admin/queues")) return true;

  if (p === "/api" || p.startsWith("/api/")) {
    if (MUTATING.has(m)) return !PUBLIC_MUTATIONS.has(`${m} ${p}`);
    // Sensitive GET/HEAD routes
    if (p === "/api/stream/skip") return true;
    if (p === "/api/library/rescan") return true;
    if (p === "/api/torrents" || p.startsWith("/api/torrents/")) return true;
    if (p === "/api/system/config") return true;
    if (p.startsWith("/api/studio/") || p === "/api/studio") return p !== "/api/studio/me";
    return false;
  }
  // Anything else (static site, streams, /status-json.xsl): only mutations outside /api are
  // not routed by the publisher, so keep them public.
  return false;
}

// ── Brute-force guard ──────────────────────────────────────

/** Max N failed logins per window per key (client IP). In memory. */
export class LoginGuard {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = LOGIN_MAX_FAILURES,
    private readonly windowMs = LOGIN_WINDOW_MS
  ) {}

  /** Seconds until the key may try again (0 = allowed). */
  public retryAfter(key: string, now = Date.now()): number {
    const list = this.prune(key, now);
    if (list.length < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
  }

  public recordFailure(key: string, now = Date.now()): void {
    const list = this.prune(key, now);
    list.push(now);
    this.failures.set(key, list);
    if (this.failures.size > 10_000) this.sweep(now);
  }

  public reset(key: string): void {
    this.failures.delete(key);
  }

  private prune(key: string, now: number): number[] {
    const list = (this.failures.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  private sweep(now: number): void {
    for (const key of [...this.failures.keys()]) this.prune(key, now);
  }
}
