import type { HeartsRepository } from "../repositories/sqlite/hearts.repo";
import { isValidTrackKey } from "./live.mapper";
import { hashIp } from "./studio-auth";

export const HEARTS_EMIT_THROTTLE_MS = 1000;
const CACHE_MAX = 5000;

export type HeartResult =
  | { ok: true; key: string; count: number; added: boolean }
  | { ok: false; error: "invalid" | "not_found"; status: number };

export interface HeartsServiceDeps {
  repo: HeartsRepository;
  /** Salt for IP hashes (never store raw IPs). */
  ipSalt: string;
  /** Whether `key` is a track listeners can see (current track or play history). */
  isKnownKey: (key: string) => boolean;
  /** Called (throttled per key, ≤ 1/s) with the new count; used for SSE `event: hearts`. */
  onCount?: (key: string, count: number) => void;
  throttleMs?: number;
}

/** One heart per IP per track key, persisted in SQLite; counts cached in memory. */
export class HeartsService {
  private readonly cache = new Map<string, number>();
  private readonly lastEmitAt = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly throttleMs: number;

  constructor(private readonly deps: HeartsServiceDeps) {
    this.throttleMs = deps.throttleMs ?? HEARTS_EMIT_THROTTLE_MS;
  }

  public heart(rawKey: unknown, ip: string, now = Date.now()): HeartResult {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!isValidTrackKey(key)) return { ok: false, error: "invalid", status: 400 };
    if (!this.deps.isKnownKey(key)) return { ok: false, error: "not_found", status: 404 };
    const added = this.deps.repo.add(key, hashIp(ip, this.deps.ipSalt), now);
    if (added) {
      this.cache.set(key, this.deps.repo.count(key));
      this.scheduleEmit(key);
    }
    return { ok: true, key, count: this.count(key), added };
  }

  public count(key: string): number {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const n = this.deps.repo.count(key);
    this.remember(key, n);
    return n;
  }

  public counts(keys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    const missing: string[] = [];
    for (const k of keys) {
      const c = this.cache.get(k);
      if (c === undefined) missing.push(k);
      else out.set(k, c);
    }
    if (missing.length) {
      const fresh = this.deps.repo.counts([...new Set(missing)]);
      for (const k of missing) {
        const n = fresh.get(k) ?? 0;
        this.remember(k, n);
        out.set(k, n);
      }
    }
    return out;
  }

  public stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private remember(key: string, n: number): void {
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(key, n);
  }

  private scheduleEmit(key: string): void {
    if (!this.deps.onCount || this.timers.has(key)) return;
    const wait = (this.lastEmitAt.get(key) ?? 0) + this.throttleMs - Date.now();
    const fire = () => {
      this.timers.delete(key);
      this.lastEmitAt.set(key, Date.now());
      if (this.lastEmitAt.size > CACHE_MAX) this.lastEmitAt.clear();
      try {
        this.deps.onCount?.(key, this.count(key));
      } catch {}
    };
    if (wait <= 0) fire();
    else this.timers.set(key, setTimeout(fire, wait));
  }
}
