import type { StreamStatus } from "../domain/types";
import type { AudioMetadataClient } from "../infrastructure/audio-metadata.client";
import type { TelnetClient } from "../infrastructure/telnet.client";

export class LiquidsoapService {
  private lastQueuedRid: string | null = null;
  private readonly durationCache = new Map<string, { duration: number; cachedAt: number }>();
  private readonly DURATION_CACHE_TTL = 3600000;
  private queueLock: Promise<void> = Promise.resolve();
  private lastManualQueueClear = 0;
  private static readonly MANUAL_CLEAR_COOLDOWN_MS = 120_000; // 2min after manual clear, don't auto-fill

  constructor(
    private readonly telnetClient: TelnetClient,
    private readonly audioMetadataClient: AudioMetadataClient,
    private readonly musicMount: string
  ) {}

  public isConnected(): boolean {
    return this.telnetClient.isConnected();
  }

  private withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queueLock.then(fn, fn);
    this.queueLock = run.then(() => {}, () => {});
    return run;
  }

  public async sendCommand(cmd: string, timeoutMs = 10000): Promise<string[]> {
    return this.telnetClient.send(cmd, timeoutMs);
  }

  public async skipTrack(): Promise<void> {
    await this.sendCommand("queue.flush_and_skip");
  }

  public async clearAndPush(filepath: string): Promise<string | null> {
    await this.sendCommand("queue.clear");
    await new Promise((r) => setTimeout(r, 200));
    return this.queuePush(filepath);
  }

  public async pausePlayback(): Promise<void> {
    await this.sendCommand("output.harbor.stop");
  }

  public async startPlayback(): Promise<void> {
    await this.sendCommand("output.harbor.start");
  }

  public async getCurrentRequestId(): Promise<string | null> {
    try {
      const lines = await this.sendCommand("request.on_air");
      const allRids: string[] = [];
      for (const line of lines) {
        for (const part of line.trim().split(/\s+/)) {
          if (part !== "") allRids.push(part);
        }
      }
      if (allRids.length === 0) return null;
      const sorted = allRids.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
      const rid = sorted[0];
      if (this.lastQueuedRid && rid !== this.lastQueuedRid) {
        this.lastQueuedRid = null;
      }
      return rid;
    } catch {
      return null;
    }
  }

  public async getRequestMetadata(rid: string): Promise<Record<string, string>> {
    try {
      const lines = await this.sendCommand(`request.metadata ${rid}`);
      const meta: Record<string, string> = {};
      for (const line of lines) {
        const eqIndex = line.indexOf("=");
        if (eqIndex > 0) {
          const key = line.substring(0, eqIndex).trim();
          let value = line.substring(eqIndex + 1).trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          meta[key] = value;
        }
      }
      return meta;
    } catch {
      return {};
    }
  }

  private async getFileDuration(filepath: string): Promise<number> {
    const cached = this.durationCache.get(filepath);
    if (cached && Date.now() - cached.cachedAt < this.DURATION_CACHE_TTL) {
      return cached.duration;
    }

    // Evict stale entries periodically
    if (this.durationCache.size > 100) {
      const now = Date.now();
      for (const [key, val] of this.durationCache) {
        if (now - val.cachedAt >= this.DURATION_CACHE_TTL) {
          this.durationCache.delete(key);
        }
      }
    }

    const localPath = filepath.replace(/^\/music\//, `${this.musicMount}/`);
    const meta = await this.audioMetadataClient.extractMetadata(localPath);
    if (meta.duration > 0) {
      this.durationCache.set(filepath, { duration: meta.duration, cachedAt: Date.now() });
      return meta.duration;
    }
    return 0;
  }

  public async getStreamStatus(): Promise<StreamStatus> {
    const connected = this.isConnected();
    try {
      const rid = await this.getCurrentRequestId();

      if (!rid) {
        return {
          connected,
          playing: false,
          currentTrack: null,
          artist: null,
          title: null,
          uptime: "0",
          duration: 0,
          elapsed: 0,
          metadata: {},
        };
      }

      const [meta, uptimeLines] = await Promise.all([
        this.getRequestMetadata(rid).catch(() => ({})),
        this.sendCommand("uptime").catch(() => ["0"]),
      ]);

      let elapsed = 0;
      if (meta.on_air_timestamp) {
        const startTime = parseFloat(meta.on_air_timestamp);
        if (!Number.isNaN(startTime)) {
          elapsed = Math.floor(Date.now() / 1000 - startTime);
        }
      }

      let duration = 0;
      const filename = meta.filename || meta.initial_uri || "";
      if (filename) {
        duration = await this.getFileDuration(filename);
      }

      return {
        connected,
        playing: true,
        currentTrack: rid,
        artist: meta.artist || null,
        title: meta.title || meta.filename || null,
        uptime: uptimeLines[0] || "0",
        duration,
        elapsed,
        metadata: meta,
      };
    } catch {
      return {
        connected,
        playing: false,
        currentTrack: null,
        artist: null,
        title: null,
        uptime: "0",
        duration: 0,
        elapsed: 0,
      };
    }
  }

  public async queuePush(filepath: string): Promise<string | null> {
    try {
      const lines = await this.sendCommand(`queue.push ${filepath}`);
      const rid = lines[0]?.trim() || null;
      if (rid) this.lastQueuedRid = rid;
      return rid;
    } catch {
      return null;
    }
  }

  public async queueList(limit?: number): Promise<{ items: { rid: string; artist: string; title: string }[]; total: number }> {
    try {
      const lines = await this.sendCommand("queue.queue");
      if (lines.length === 0) return { items: [], total: 0 };
      const rids = lines[0].split(/\s+/).filter(Boolean);
      const total = rids.length;
      const ridsToFetch = limit ? rids.slice(0, limit) : rids;
      const metas = await Promise.all(
        ridsToFetch.map((rid) => this.getRequestMetadata(rid).catch(() => ({})))
      );
      const items = ridsToFetch.map((rid, i) => ({
        rid,
        artist: metas[i].artist || "",
        title: metas[i].title || metas[i].filename || rid,
      }));
      return { items, total };
    } catch {
      return { items: [], total: 0 };
    }
  }

  public async queueRemove(rid: string): Promise<boolean> {
    try {
      await this.sendCommand(`queue.remove ${rid}`);
      console.log(`[LiquidsoapService] queueRemove: removed rid ${rid} via native command`);
      return true;
    } catch (err: any) {
      console.error(`[LiquidsoapService] queueRemove failed:`, err.message);
      return false;
    }
  }

  public queueInsert(index: number, filepath: string): Promise<boolean> {
    return this.withQueueLock(async () => {
      try {
        const lines = await this.sendCommand("queue.queue");
        const queued = lines.length > 0 ? lines[0].split(/\s+/).filter(Boolean) : [];
        const metas = await Promise.all(
          queued.map((r) => this.getRequestMetadata(r).catch(() => ({})))
        );
        const uris = metas.map((m) => m.initial_uri || m.filename || "").filter(Boolean);
        const safeIndex = Math.max(0, Math.min(index, uris.length));
        uris.splice(safeIndex, 0, filepath);

        await this.sendCommand("queue.clear");
        await new Promise((r) => setTimeout(r, 200));

        let pushedCount = 0;
        for (const uri of uris) {
          const result = await this.queuePush(uri).catch(() => null);
          if (result) pushedCount++;
        }
        console.log(
          `[LiquidsoapService] queueInsert: cleared and rebuilt queue with ${pushedCount}/${uris.length} items`
        );
        return true;
      } catch (err: any) {
        console.error(`[LiquidsoapService] queueInsert failed:`, err.message);
        return false;
      }
    });
  }

  public async queueClear(): Promise<void> {
    try {
      await this.sendCommand("queue.clear");
      this.lastManualQueueClear = Date.now();
      console.log("[LiquidsoapService] Queue cleared manually");
    } catch {}
  }

  public isManualClearActive(): boolean {
    return Date.now() - this.lastManualQueueClear < LiquidsoapService.MANUAL_CLEAR_COOLDOWN_MS;
  }

  public async playFileNow(filepath: string): Promise<boolean> {
    try {
      const rid = await this.queuePush(filepath);
      if (!rid) return false;
      await new Promise((r) => setTimeout(r, 1000));
      await this.sendCommand("queue.skip");
      return true;
    } catch {
      return false;
    }
  }

  public async playFilesNow(filepaths: string[]): Promise<boolean> {
    try {
      await this.sendCommand("queue.clear");
      await new Promise((r) => setTimeout(r, 500));
      for (const filepath of filepaths) {
        await this.queuePush(filepath);
      }
      await new Promise((r) => setTimeout(r, 500));
      await this.sendCommand("queue.skip");
      return true;
    } catch {
      return false;
    }
  }

  public async reloadPlaylist(): Promise<void> {
    await this.sendCommand("reload");
  }

  public async requestSeek(rid: string, position: number): Promise<boolean> {
    try {
      const lines = await this.sendCommand(`request.seek ${rid} ${position}`);
      return lines.length > 0;
    } catch {
      return false;
    }
  }
}
