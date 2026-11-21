import { randomBytes } from "node:crypto";
import type { Track } from "../domain/types";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlayHistoryRepository } from "../repositories/sqlite/play-history.repo";
import type { SongRequestRepository } from "../repositories/sqlite/song-request.repo";
import type { CoverService } from "./cover.service";
import { fileTrackKey, toDbPath } from "./live.mapper";
import {
  checkRequestLimits,
  type PublicRequestItem,
  type RequestErrorCode,
  requestability,
  type SongRequestRow,
  type StudioRequestItem,
  selectPublicRequests,
  shouldAutoApprove,
  toPublicRequest,
  toStudioRequest,
  validateRequestInput,
} from "./song-requests.mapper";
import { hashIp } from "./studio-auth";

export const SEARCH_MAX = 20;
export const SEARCH_MIN_CHARS = 2;
const MAINTENANCE_INTERVAL_MS = 60_000;
/**
 * A queued request whose file left Buncaster's queue without being seen playing.
 * Generous: Buncaster pre-loads the queue head into the idle crossfade deck (it vanishes from
 * /api/queue while the current track — possibly long — is still playing).
 */
const QUEUED_STALE_MS = 30 * 60 * 1000;
const PENDING_EXPIRE_MS = 12 * 60 * 60 * 1000;

export interface SearchItem {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  duration: number;
  requestable: boolean;
  reason?: "recently_played" | "already_requested";
}

export type ServiceError = { ok: false; error: string; status: number; retryAfter?: number };

export interface SongRequestsDeps {
  repo: SongRequestRepository;
  libraryRepo: Pick<LibraryRepository, "getTrackById" | "search">;
  historyRepo: Pick<PlayHistoryRepository, "lastPlayedAtByKeys" | "lastPlayedAt">;
  coverService: Pick<CoverService, "register" | "coverUrlFor">;
  /** Direct Buncaster enqueue (no BullMQ). `filepath` = "/music/songs/..". */
  enqueueFile: (filepath: string) => Promise<boolean>;
  /** Best-effort removal from Buncaster's queue by file path. */
  removeFromQueue?: (file: string) => Promise<boolean>;
  /** Library paths ("songs/..") currently sitting in Buncaster's queue (live poller snapshot). */
  getQueueFiles: () => Set<string>;
  /** Library path currently playing, or null. */
  getCurrentFile?: () => string | null;
  /** False while Buncaster is unreachable (don't expire queued requests on bad data). */
  isEngineHealthy?: () => boolean;
  ipSalt: string;
  autoApprove: boolean;
  /** Called with the public list whenever it changes (SSE `event: requests`). */
  onPublicChange?: (list: PublicRequestItem[]) => void;
}

/**
 * Listener song requests: validation + limits, moderation (approve → Buncaster queue),
 * and lifecycle (queued → played when the live poller sees the track start).
 */
export class SongRequestsService {
  private lastPublicSig = "";
  private lastMaintenanceAt = 0;
  private readonly approving = new Set<string>();

  constructor(private readonly deps: SongRequestsDeps) {}

  // ── Public ────────────────────────────────────────────────

  public search(rawQ: string | undefined, rawLimit: string | undefined, now = Date.now()) {
    const q = (rawQ || "").trim().slice(0, 100);
    if (q.length < SEARCH_MIN_CHARS) return [];
    const n = Number.parseInt(rawLimit || "", 10);
    const limit = Number.isFinite(n) ? Math.min(SEARCH_MAX, Math.max(1, n)) : 10;

    const songs = this.deps.libraryRepo
      .search(q, 60)
      .items.filter((t) => t.type === "song")
      .slice(0, limit);
    const keys = songs.map((t) => fileTrackKey(t.file));
    const lastPlayed = this.deps.historyRepo.lastPlayedAtByKeys(keys);
    const busy = this.busyFiles();

    return songs.map((t, i): SearchItem => {
      const key = this.deps.coverService.register(t.file);
      const flag = requestability(lastPlayed.get(keys[i]) ?? null, busy.has(t.file), now);
      return {
        id: t.id,
        title: t.title,
        artist: t.artist || "",
        album: t.album ? t.album : null,
        coverUrl: this.deps.coverService.coverUrlFor(key),
        duration: Math.round((t.duration || 0) * 10) / 10,
        ...flag,
      };
    });
  }

  public async create(
    body: unknown,
    ip: string,
    now = Date.now()
  ): Promise<{ ok: true; id: string; status: SongRequestRow["status"] } | ServiceError> {
    const v = validateRequestInput(body);
    if (!v.ok) return { ok: false, error: v.error, status: 400 };

    const track = this.findSong(v.value.trackId);
    if (!track) return this.fail("not_found", 404);

    const ipHash = hashIp(ip, this.deps.ipSalt);
    const key = fileTrackKey(track.file);
    const limits = checkRequestLimits({
      now,
      lastRequestFromIpAt: this.deps.repo.lastCreatedAtByIp(ipHash),
      lastPlayedAt: this.deps.historyRepo.lastPlayedAt(key),
      alreadyRequested: this.busyFiles().has(track.file),
      pendingCount: this.deps.repo.countByStatus("pending"),
    });
    if (!limits.ok)
      return {
        ok: false,
        error: limits.error,
        status: limits.status,
        retryAfter: limits.retryAfter,
      };

    const row: SongRequestRow = {
      id: `req_${randomBytes(8).toString("hex")}`,
      trackId: track.id,
      file: track.file,
      trackKey: key,
      title: track.title,
      artist: track.artist || "",
      name: v.value.name,
      message: v.value.message,
      status: "pending",
      ipHash,
      createdAt: now,
      updatedAt: now,
      queuedAt: null,
      playedAt: null,
    };
    this.deps.repo.insert(row);

    let status: SongRequestRow["status"] = "pending";
    if (shouldAutoApprove(this.deps.autoApprove, this.deps.repo.countByStatus("queued"))) {
      const res = await this.approve(row.id, now, false);
      if (res.ok) status = "queued";
    }
    this.notify();
    return { ok: true, id: row.id, status };
  }

  public listPublic(): PublicRequestItem[] {
    const rows = [
      ...this.deps.repo.listByStatus(["pending", "queued"], 100),
      ...this.deps.repo.listByStatus(["played"], 10),
    ];
    return selectPublicRequests(rows).map((r) => toPublicRequest(r, this.coverFor(r)));
  }

  // ── Studio ────────────────────────────────────────────────

  public listStudio(limit = 200): StudioRequestItem[] {
    return this.deps.repo.listRecent(limit).map((r) => toStudioRequest(r, this.coverFor(r)));
  }

  public pendingCount(): number {
    return this.deps.repo.countByStatus("pending");
  }

  public async approve(
    id: string,
    now = Date.now(),
    notify = true
  ): Promise<{ ok: true; data: StudioRequestItem } | ServiceError> {
    const row = this.deps.repo.get(id);
    if (!row) return this.fail("not_found", 404);
    if (row.status !== "pending" || this.approving.has(id)) return this.fail("invalid_state", 409);
    this.approving.add(id);
    let ok = false;
    try {
      ok = await this.deps.enqueueFile(`/music/${row.file}`);
    } finally {
      this.approving.delete(id);
    }
    if (!ok) return this.fail("enqueue_failed", 502);
    this.deps.repo.update(id, { status: "queued", queuedAt: now }, now);
    if (notify) this.notify();
    return { ok: true, data: this.studioItem(id)! };
  }

  public async reject(
    id: string,
    now = Date.now()
  ): Promise<{ ok: true; data: StudioRequestItem } | ServiceError> {
    const row = this.deps.repo.get(id);
    if (!row) return this.fail("not_found", 404);
    if (row.status !== "pending" && row.status !== "queued") return this.fail("invalid_state", 409);
    if (row.status === "queued" && this.deps.removeFromQueue) {
      await this.deps.removeFromQueue(row.file).catch(() => false);
    }
    this.deps.repo.update(id, { status: "rejected" }, now);
    this.notify();
    return { ok: true, data: this.studioItem(id)! };
  }

  /** Studio "add to queue": any library track, straight to Buncaster (no BullMQ). */
  public async enqueueTrack(trackId: unknown): Promise<{ ok: true } | ServiceError> {
    if (typeof trackId !== "string" || !trackId.trim()) return this.fail("invalid", 400);
    const track = this.deps.libraryRepo.getTrackById(trackId.trim());
    if (!track) return this.fail("not_found", 404);
    const ok = await this.deps.enqueueFile(`/music/${track.file}`);
    return ok ? { ok: true } : this.fail("enqueue_failed", 502);
  }

  /** Test/maintenance helper: hard-delete a request. */
  public remove(id: string): boolean {
    if (!this.deps.repo.get(id)) return false;
    this.deps.repo.deleteById(id);
    this.notify();
    return true;
  }

  // ── Live poller hooks ─────────────────────────────────────

  /**
   * A song started playing. If a queued request is waiting for it, mark it played and
   * return its dedication for the now payload.
   */
  public onTrackStart(
    file: string,
    now = Date.now()
  ): { name: string | null; message: string | null } | null {
    const dbPath = toDbPath(file);
    const queued = this.deps.repo
      .listByStatus(["queued"], 100)
      .filter((r) => r.file === dbPath)
      .sort((a, b) => (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt));
    const hit = queued[0];
    if (!hit) return null;
    this.deps.repo.update(hit.id, { status: "played", playedAt: now }, now);
    void this.promotePending(now);
    this.notify();
    return { name: hit.name, message: hit.message };
  }

  /** Periodic housekeeping (called from the live poller; self-throttled to 1/min). */
  public tick(now = Date.now()): void {
    if (now - this.lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenanceAt = now;
    let changed = false;

    for (const r of this.deps.repo.listByStatus(["pending"], 500)) {
      if (now - r.createdAt > PENDING_EXPIRE_MS) {
        this.deps.repo.update(r.id, { status: "rejected" }, now);
        changed = true;
      }
    }

    if (this.deps.isEngineHealthy?.() !== false) {
      const inQueue = this.deps.getQueueFiles();
      const current = this.deps.getCurrentFile?.() ?? null;
      for (const r of this.deps.repo.listByStatus(["queued"], 500)) {
        const since = r.queuedAt ?? r.createdAt;
        if (now - since < QUEUED_STALE_MS || inQueue.has(r.file) || current === r.file) continue;
        // Left the queue unseen: played while we weren't looking, or the queue was cleared
        const last = this.deps.historyRepo.lastPlayedAt(r.trackKey);
        if (last !== null && last >= since) {
          this.deps.repo.update(r.id, { status: "played", playedAt: last }, now);
        } else {
          this.deps.repo.update(r.id, { status: "rejected" }, now);
        }
        changed = true;
      }
    }

    if (changed) {
      void this.promotePending(now);
      this.notify();
    }
  }

  // ── Internals ─────────────────────────────────────────────

  private async promotePending(now: number): Promise<void> {
    if (!this.deps.autoApprove) return;
    const pending = this.deps.repo.listByStatus(["pending"], 100).reverse(); // oldest first
    let queued = this.deps.repo.countByStatus("queued");
    for (const r of pending) {
      if (!shouldAutoApprove(true, queued)) break;
      const res = await this.approve(r.id, now, false);
      if (res.ok) queued++;
    }
    this.notify();
  }

  /** Library paths that can't be requested again: pending/queued requests + Buncaster queue. */
  private busyFiles(): Set<string> {
    const set = new Set<string>();
    for (const r of this.deps.repo.listByStatus(["pending", "queued"], 500)) set.add(r.file);
    try {
      for (const f of this.deps.getQueueFiles()) set.add(f);
    } catch {}
    return set;
  }

  private findSong(trackId: string): Track | null {
    const t = this.deps.libraryRepo.getTrackById(trackId);
    return t && t.type === "song" ? t : null;
  }

  private coverFor(r: SongRequestRow): string | null {
    return this.deps.coverService.coverUrlFor(this.deps.coverService.register(r.file));
  }

  private studioItem(id: string): StudioRequestItem | null {
    const r = this.deps.repo.get(id);
    return r ? toStudioRequest(r, this.coverFor(r)) : null;
  }

  private fail(
    error: RequestErrorCode | "invalid_state" | "enqueue_failed",
    status: number
  ): ServiceError {
    return { ok: false, error, status };
  }

  private notify(): void {
    if (!this.deps.onPublicChange) return;
    try {
      const list = this.listPublic();
      const sig = JSON.stringify(list);
      if (sig === this.lastPublicSig) return;
      this.lastPublicSig = sig;
      this.deps.onPublicChange(list);
    } catch (err: any) {
      console.error("[SongRequests] notify failed:", err.message);
    }
  }
}
