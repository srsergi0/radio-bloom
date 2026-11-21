import type { BuncasterClient } from "../infrastructure/buncaster.client";
import type { ListenerSamplesRepository } from "../repositories/sqlite/listener-samples.repo";

export const REACH_BUCKET_MS = 5 * 60 * 1000;
export const REACH_WINDOW_MS = 24 * 60 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_MAX_AGE_MS = 60_000;

export interface EngineInfo {
  ok: boolean;
  uptimeSeconds: number;
  rssMb: number | null;
  live: boolean;
}

export function bucketOf(ms: number): number {
  return Math.floor(ms / REACH_BUCKET_MS) * REACH_BUCKET_MS;
}

/** Maps Buncaster GET /health to the studio engine block. */
export function mapEngineHealth(health: any): EngineInfo {
  if (!health || typeof health !== "object")
    return { ok: false, uptimeSeconds: 0, rssMb: null, live: false };
  const rss = Number(health.memory?.rss);
  return {
    ok: health.status === "ok",
    uptimeSeconds: Math.max(0, Math.floor(Number(health.uptime) || 0)),
    rssMb: Number.isFinite(rss) && rss > 0 ? Math.round(rss) : null,
    live: !!(health.nowPlaying?.isLive || health.nowPlaying?.type === "live"),
  };
}

/**
 * Studio "reach": one listener sample per 5-minute bucket (the max seen in it) over the last
 * 24 h, kept in memory and persisted to SQLite so restarts don't wipe the chart.
 * Also caches Buncaster /health for the overview engine block and /status-json.xsl.
 */
export class ReachService {
  private readonly buckets = new Map<number, number>();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private engine: EngineInfo | null = null;
  private engineAt = 0;
  private engineInFlight: Promise<EngineInfo> | null = null;

  constructor(
    private readonly repo: ListenerSamplesRepository,
    private readonly getListeners: () => number,
    private readonly buncasterClient?: Pick<BuncasterClient, "getHealthWithTimeout">
  ) {
    try {
      for (const s of repo.since(Date.now() - REACH_WINDOW_MS)) this.buckets.set(s.t, s.n);
    } catch (err: any) {
      console.error("[ReachService] load failed:", err.message);
    }
  }

  public start(): void {
    if (this.sampleTimer) return;
    this.sample();
    this.sampleTimer = setInterval(() => {
      this.sample();
      void this.refreshEngine();
    }, SAMPLE_INTERVAL_MS);
    void this.refreshEngine();
  }

  public stop(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  /** Records `n` listeners at `now` (bucket keeps the max). */
  public observe(n: number, now = Date.now()): void {
    const t = bucketOf(now);
    const prev = this.buckets.get(t);
    if (prev !== undefined && prev >= n) return;
    this.buckets.set(t, n);
    try {
      this.repo.upsert(t, n);
    } catch {}
    this.prune(now);
  }

  /** Last 24 h, oldest first: `{ t: bucket start (epoch ms), n }`. */
  public series(now = Date.now()): Array<{ t: number; n: number }> {
    const from = now - REACH_WINDOW_MS;
    return [...this.buckets.entries()]
      .filter(([t]) => t >= from)
      .sort((a, b) => a[0] - b[0])
      .map(([t, n]) => ({ t, n }));
  }

  public async getEngine(): Promise<EngineInfo> {
    if (this.engine && Date.now() - this.engineAt < HEALTH_MAX_AGE_MS) return this.engine;
    return this.refreshEngine();
  }

  /** Cached engine info without waiting (null until the first /health answer). */
  public peekEngine(): EngineInfo | null {
    return this.engine;
  }

  private sample(): void {
    try {
      this.observe(this.getListeners());
    } catch {}
  }

  private refreshEngine(): Promise<EngineInfo> {
    if (this.engineInFlight) return this.engineInFlight;
    const client = this.buncasterClient;
    const job = (async () => {
      let info: EngineInfo;
      try {
        info = client
          ? mapEngineHealth(await client.getHealthWithTimeout(HEALTH_TIMEOUT_MS))
          : mapEngineHealth(null);
      } catch {
        info = mapEngineHealth(null);
      }
      this.engine = info;
      this.engineAt = Date.now();
      return info;
    })().finally(() => {
      this.engineInFlight = null;
    });
    this.engineInFlight = job;
    return job;
  }

  private prune(now: number): void {
    const cutoff = now - REACH_WINDOW_MS - REACH_BUCKET_MS;
    let removed = false;
    for (const t of this.buckets.keys()) {
      if (t < cutoff) {
        this.buckets.delete(t);
        removed = true;
      }
    }
    if (removed) {
      try {
        this.repo.pruneBefore(cutoff);
      } catch {}
    }
  }
}
