import type { StreamStatus } from "../domain/types";
import type { FfprobeClient } from "../infrastructure/ffprobe.client";
import type { TelnetClient } from "../infrastructure/telnet.client";

export class LiquidsoapService {
  private lastQueuedRid: string | null = null;
  private readonly durationCache = new Map<string, { duration: number; cachedAt: number }>();
  private readonly DURATION_CACHE_TTL = 3600000;

  constructor(
    private readonly telnetClient: TelnetClient,
    private readonly ffprobeClient: FfprobeClient,
    private readonly musicMount: string
  ) {}

  public isConnected(): boolean {
    return this.telnetClient.isConnected();
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

  private getFileDuration(filepath: string): number {
    const cached = this.durationCache.get(filepath);
    if (cached && Date.now() - cached.cachedAt < this.DURATION_CACHE_TTL) {
      return cached.duration;
    }

    const localPath = filepath.replace(/^\/music\//, `${this.musicMount}/`);
    const meta = this.ffprobeClient.extractMetadata(localPath);
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
        duration = this.getFileDuration(filename);
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

  public async queueList(): Promise<{ rid: string; artist: string; title: string }[]> {
    try {
      const lines = await this.sendCommand("queue.queue");
      if (lines.length === 0) return [];
      const rids = lines[0].split(/\s+/).filter(Boolean);
      const items: { rid: string; artist: string; title: string }[] = [];
      for (const rid of rids) {
        const meta = await this.getRequestMetadata(rid).catch(() => ({}));
        items.push({
          rid,
          artist: meta.artist || "",
          title: meta.title || meta.filename || rid,
        });
      }
      return items;
    } catch {
      return [];
    }
  }

  public async queueRemove(rid: string): Promise<boolean> {
    try {
      const lines = await this.sendCommand("queue.queue");
      if (lines.length === 0) return false;
      const queued = lines[0].split(/\s+/).filter(Boolean);
      const idx = queued.indexOf(rid);
      if (idx === -1) return false;

      const uris: string[] = [];
      for (const r of queued) {
        const meta = await this.getRequestMetadata(r).catch(() => ({}));
        uris.push(meta.initial_uri || meta.filename || "");
      }
      if (idx >= uris.length) return false;
      uris.splice(idx, 1);

      await this.sendCommand("queue.clear");
      await new Promise((r) => setTimeout(r, 500));
      for (const uri of uris) {
        if (uri) await this.queuePush(uri).catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  public async queueInsert(index: number, filepath: string): Promise<boolean> {
    try {
      const lines = await this.sendCommand("queue.queue");
      const queued = lines.length > 0 ? lines[0].split(/\s+/).filter(Boolean) : [];
      const uris: string[] = [];
      for (const r of queued) {
        const meta = await this.getRequestMetadata(r).catch(() => ({}));
        uris.push(meta.initial_uri || meta.filename || "");
      }
      const safeIndex = Math.max(0, Math.min(index, uris.length));
      uris.splice(safeIndex, 0, filepath);

      await this.sendCommand("queue.clear");
      await new Promise((r) => setTimeout(r, 500));
      for (const uri of uris) {
        if (uri) await this.queuePush(uri).catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  public async queueClear(): Promise<void> {
    try {
      await this.sendCommand("queue.clear");
    } catch {}
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

  public async requestSeek(rid: string, position: number): Promise<boolean> {
    try {
      const lines = await this.sendCommand(`request.seek ${rid} ${position}`);
      return lines.length > 0;
    } catch {
      return false;
    }
  }

  public async reloadPlaylist(): Promise<void> {
    await this.sendCommand("reload");
  }

  // ============================================================
  // Live Status
  // ============================================================

  public async isLiveInputConnected(): Promise<boolean> {
    const lines = await this.sendCommand("live.connected");
    return lines[0]?.trim() === "true";
  }
}
