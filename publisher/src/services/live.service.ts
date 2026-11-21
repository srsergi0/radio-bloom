import type {
  LiveHistoryItem,
  LiveListeners,
  LiveNowPayload,
  LiveSchedulePayload,
  LiveUpNextItem,
  Track,
} from "../domain/types";
import type { BuncasterClient, BuncasterQueueItem } from "../infrastructure/buncaster.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlayHistoryRepository } from "../repositories/sqlite/play-history.repo";
import type { CoverService } from "./cover.service";
import {
  type BuncasterNowPlaying,
  buildNowPayload,
  computeListeners,
  expandScheduleSlots,
  fileTrackKey,
  findActiveHost,
  isInterludioFile,
  LIVE_TIMEZONE,
  type LiveStateSnapshot,
  limaClock,
  mapTrack,
  nowSignature,
  resolveSource,
  STATION,
  toDbPath,
  toLiveHost,
} from "./live.mapper";
import type { LocutorService } from "./locutor.service";

export interface LocalListenerProbe {
  opus: number;
  mp3: number;
  opusUpstream: boolean;
  mp3Upstream: boolean;
}

export interface LiveSubscriber {
  /** Writes a raw SSE chunk. Returns false when the client is gone or too slow. */
  send(chunk: string): boolean;
  close(): void;
}

export interface LiveServiceDeps {
  buncasterClient: BuncasterClient;
  libraryRepo: LibraryRepository;
  locutorService: Pick<LocutorService, "listLocutors" | "listSchedules">;
  historyRepo: PlayHistoryRepository;
  coverService: CoverService;
  opusEnabled: boolean;
  mp3Enabled: boolean;
  getLocalListeners: () => LocalListenerProbe;
  pollIntervalMs?: number;
}

const POLL_INTERVAL_MS = 2000;
const PING_INTERVAL_MS = 20_000;
const LISTENERS_THROTTLE_MS = 5000;
const REQUEST_TIMEOUT_MS = 3000;
const MAX_FAILURES_BEFORE_CLEAR = 3;
const MAX_SUBSCRIBERS = 5000;
const UP_NEXT_MAX = 5;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Listener API state. ONE poller (Buncaster /status + queue every ~2s) feeds an in-memory
 * snapshot that every HTTP/SSE client reads; SSE subscribers are a fan-out set.
 */
export class LiveService {
  private readonly subscribers = new Set<LiveSubscriber>();
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private listenersTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private failures = 0;
  private firstTick: Promise<void> | null = null;

  // Raw inputs from the last successful poll
  private np: BuncasterNowPlaying | null = null;
  private queue: BuncasterQueueItem[] = [];
  private buncasterOpus = 0;
  private buncasterMp3 = 0;
  private bitrateKbps = 0;

  // Per-track memo
  private currentPlayId: string | null = null;
  private currentLib: Track | null = null;
  private currentFromQueue = false;
  private liveSince: number | null = null;
  private prevQueueFiles = new Set<string>();
  private upNextSig = "";
  private upNextLib = new Map<string, Track>();

  // Derived
  private state: LiveStateSnapshot | null = null;
  private lastNowSig = "";
  private lastListenersSig = "";
  private lastListenersEmitAt = 0;
  private peakToday = 0;
  private peakDateKey = "";

  constructor(private readonly deps: LiveServiceDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  public start(): void {
    if (this.pollTimer) return;
    this.firstTick = this.tick();
    this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.pingTimer = setInterval(() => this.fanOut(": ping\n\n"), PING_INTERVAL_MS);
  }

  public stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.listenersTimer) clearTimeout(this.listenersTimer);
    this.pollTimer = this.pingTimer = this.listenersTimer = null;
    for (const sub of this.subscribers) {
      try {
        sub.close();
      } catch {}
    }
    this.subscribers.clear();
  }

  public isFull(): boolean {
    return this.subscribers.size >= MAX_SUBSCRIBERS;
  }

  public subscriberCount(): number {
    return this.subscribers.size;
  }

  // ── Read API ──────────────────────────────────────────────

  public async getNow(): Promise<LiveNowPayload> {
    if (!this.state && this.firstTick) {
      await withTimeout(this.firstTick, REQUEST_TIMEOUT_MS + 1000).catch(() => {});
    }
    return buildNowPayload(this.state ?? this.compose(Date.now()), Date.now());
  }

  public getSchedule(now = Date.now()): LiveSchedulePayload {
    const clock = limaClock(now);
    return {
      timezone: LIVE_TIMEZONE,
      now: { dayOfWeek: clock.dayOfWeek, minute: clock.minute },
      slots: expandScheduleSlots(
        this.deps.locutorService.listLocutors(),
        this.deps.locutorService.listSchedules()
      ),
    };
  }

  public getHistory(limit: number): LiveHistoryItem[] {
    return this.deps.historyRepo.list(limit).map((r) => ({
      title: r.title,
      artist: r.artist,
      album: r.album || null,
      coverUrl: this.deps.coverService.coverUrlFor(r.trackKey),
      duration: r.duration,
      playedAt: r.playedAt,
    }));
  }

  /** Registers an SSE client; sends the current `now` immediately. Returns the unsubscribe fn. */
  public async subscribe(sub: LiveSubscriber): Promise<(() => void) | null> {
    if (this.subscribers.size >= MAX_SUBSCRIBERS) return null;
    const payload = await this.getNow();
    if (!sub.send(`retry: 5000\n\n${sseEvent("now", payload)}`)) return null;
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  // ── Poller ────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [statusRes, queueRes] = await Promise.allSettled([
        this.deps.buncasterClient.getStatusWithTimeout(REQUEST_TIMEOUT_MS),
        withTimeout(this.deps.buncasterClient.getQueue(), REQUEST_TIMEOUT_MS),
      ]);

      if (statusRes.status === "fulfilled") {
        const s = statusRes.value;
        this.failures = 0;
        this.np = (s.nowPlaying as BuncasterNowPlaying | null | undefined) ?? null;
        this.buncasterOpus = s.listenersOpus ?? 0;
        this.buncasterMp3 = s.listenersMp3 ?? Math.max(0, (s.listeners ?? 0) - this.buncasterOpus);
        const kbps =
          this.deps.opusEnabled && s.opusTierEnabled
            ? s.opusTierBitrateKbps
            : s.fallbackBitrateKbps;
        if (kbps) this.bitrateKbps = kbps;
      } else if (++this.failures >= MAX_FAILURES_BEFORE_CLEAR) {
        this.np = null; // Buncaster unreachable: stop advertising a stale track
        this.buncasterOpus = this.buncasterMp3 = 0;
      }

      const now = Date.now();
      this.onTrackObserved(now);
      if (queueRes.status === "fulfilled") {
        this.queue = queueRes.value;
        this.prevQueueFiles = new Set(this.queue.map((q) => toDbPath(q.file)));
      }
      this.publish(now);
    } catch (err: any) {
      console.error("[LiveService] tick failed:", err.message);
    } finally {
      this.ticking = false;
    }
  }

  /** Handles track transitions: library lookup, source detection, history, cover warm-up. */
  private onTrackObserved(now: number): void {
    const np = this.np;
    const isLive = !!np && (np.isLive || np.type === "live");
    this.liveSince = isLive ? (this.liveSince ?? now) : null;

    const probe = mapTrack(np, { library: null, coverUrl: null, liveSince: this.liveSince, now });
    // Identity of a play = key + startedAt, so a repeated file is still a new play
    const playId = probe ? (isLive ? probe.key : `${probe.key}@${np?.startedAt ?? ""}`) : null;
    if (playId === this.currentPlayId) return;

    this.currentPlayId = playId;
    this.currentLib = null;
    // Queue tracks are reported as "fallback" by Buncaster: infer from the previous queue snapshot
    this.currentFromQueue = !!np?.file && this.prevQueueFiles.has(toDbPath(np.file));
    if (!np?.file || isLive) return;

    const dbPath = toDbPath(np.file);
    try {
      this.currentLib = this.deps.libraryRepo.getTrackByFile(dbPath);
    } catch {}

    if (isInterludioFile(np.file) || this.currentLib?.type === "interludio") return;

    const coverKey = this.deps.coverService.register(np.file);
    this.deps.coverService
      .ensure(coverKey)
      .then(() => this.publish(Date.now()))
      .catch(() => {});

    const track = mapTrack(np, {
      library: this.currentLib,
      coverUrl: null,
      liveSince: null,
      now,
    });
    if (track) this.recordHistory(track.key, dbPath, track, np.startedAt ?? now);
  }

  private recordHistory(
    key: string,
    file: string,
    t: { title: string; artist: string; album: string | null; duration: number },
    playedAt: number
  ): void {
    try {
      const last = this.deps.historyRepo.latest();
      // Publisher restart while the same track is still playing → don't duplicate
      if (last && last.trackKey === key && Math.abs(last.playedAt - playedAt) < 10_000) return;
      this.deps.historyRepo.insert({
        trackKey: key,
        file,
        title: t.title,
        artist: t.artist,
        album: t.album ?? "",
        duration: t.duration,
        playedAt,
      });
    } catch (err: any) {
      console.error("[LiveService] history insert failed:", err.message);
    }
  }

  private compose(now: number): LiveStateSnapshot {
    let host = null;
    try {
      host = toLiveHost(
        findActiveHost(
          this.deps.locutorService.listLocutors(),
          this.deps.locutorService.listSchedules(),
          now
        )
      );
    } catch {}

    const np = this.np;
    const key = np?.file ? fileTrackKey(np.file) : null;
    const track = mapTrack(np, {
      library: this.currentLib,
      coverUrl: key ? this.deps.coverService.coverUrlFor(key) : null,
      liveSince: this.liveSince,
      hostName: host?.name ?? null,
      now,
    });
    const isLive = !!np && (np.isLive || np.type === "live");

    return {
      isLive,
      source: resolveSource(np, this.currentFromQueue),
      track,
      host,
      listeners: this.computeListenerState(now),
      stream: { opus: "/radiobloom.opus", mp3: "/radiobloom.mp3", bitrateKbps: this.bitrateKbps },
      upNext: this.composeUpNext(host?.name ?? null),
    };
  }

  private computeListenerState(now: number): LiveListeners {
    const local = this.deps.getLocalListeners();
    const counts = computeListeners({
      buncasterOpus: this.buncasterOpus,
      buncasterMp3: this.buncasterMp3,
      localOpus: local.opus,
      localMp3: local.mp3,
      opusUpstream: local.opusUpstream,
      mp3Upstream: local.mp3Upstream,
    });
    const { dateKey } = limaClock(now);
    if (dateKey !== this.peakDateKey) {
      this.peakDateKey = dateKey; // Lima midnight → reset
      this.peakToday = 0;
    }
    this.peakToday = Math.max(this.peakToday, counts.current);
    return { ...counts, peakToday: this.peakToday };
  }

  private composeUpNext(hostName: string | null): LiveUpNextItem[] {
    const items = this.queue.slice(0, UP_NEXT_MAX);
    const files = items.map((q) => toDbPath(q.file));
    const sig = files.join("\n");
    if (sig !== this.upNextSig) {
      this.upNextSig = sig;
      try {
        this.upNextLib = files.length ? this.deps.libraryRepo.getTracksByFiles(files) : new Map();
      } catch {
        this.upNextLib = new Map();
      }
    }
    return items.map((q, i) => {
      const dbPath = files[i];
      const lib = this.upNextLib.get(dbPath) ?? null;
      if (isInterludioFile(q.file) || lib?.type === "interludio") {
        return {
          title: "Interludio",
          artist: hostName || STATION.name,
          type: "interludio" as const,
          coverUrl: null,
        };
      }
      const base = (dbPath.split("/").pop() || "").replace(/\.[^.]+$/, "");
      const key = this.deps.coverService.register(dbPath);
      return {
        title: q.title || lib?.title || base,
        artist: q.artist || lib?.artist || "",
        type: "song" as const,
        coverUrl: this.deps.coverService.coverUrlFor(key),
      };
    });
  }

  /** Recomputes the snapshot and pushes SSE events when something listeners care about changed. */
  private publish(now: number): void {
    const state = this.compose(now);
    this.state = state;

    const sig = nowSignature(state);
    if (sig !== this.lastNowSig) {
      this.lastNowSig = sig;
      this.lastListenersSig = JSON.stringify(state.listeners);
      if (this.subscribers.size > 0) this.fanOut(sseEvent("now", buildNowPayload(state, now)));
      return;
    }
    this.maybeEmitListeners();
  }

  private maybeEmitListeners(): void {
    if (!this.state || this.listenersTimer) return;
    const sig = JSON.stringify(this.state.listeners);
    if (sig === this.lastListenersSig) return;
    const wait = this.lastListenersEmitAt + LISTENERS_THROTTLE_MS - Date.now();
    if (wait > 0) {
      this.listenersTimer = setTimeout(() => {
        this.listenersTimer = null;
        this.maybeEmitListeners();
      }, wait);
      return;
    }
    this.lastListenersSig = sig;
    this.lastListenersEmitAt = Date.now();
    if (this.subscribers.size > 0) this.fanOut(sseEvent("listeners", this.state.listeners));
  }

  private fanOut(chunk: string): void {
    for (const sub of this.subscribers) {
      if (!sub.send(chunk)) {
        this.subscribers.delete(sub);
        try {
          sub.close();
        } catch {}
      }
    }
  }
}
