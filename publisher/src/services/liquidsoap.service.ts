import type { StreamStatus } from "../domain/types";
import type { AudioMetadataClient } from "../infrastructure/audio-metadata.client";
import type { TelnetClient } from "../infrastructure/telnet.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlaylistRepository } from "../repositories/sqlite/playlist.repo";
import type { LiquidsoapQueueService } from "./liquidsoap-queue.service";

function toDbPath(filepath: string): string {
  // Normalize: "/music/songs/file.mp3" → "songs/file.mp3"
  //           "D:\music\interludios\file.mp3" → "interludios/file.mp3"
  //           "/app/music/songs/file.mp3" → "songs/file.mp3"
  const forwardSlash = filepath.replace(/\\/g, "/");
  const match = forwardSlash.match(/(?:^|\/)(songs|interludios)\/(.+)$/);
  return match ? `${match[1]}/${match[2]}` : forwardSlash;
}

export class LiquidsoapService {
  private lastQueuedRid: string | null = null;
  private readonly durationCache = new Map<string, { duration: number; cachedAt: number }>();
  private readonly DURATION_CACHE_TTL = 3600000;
  private queueLock: Promise<void> = Promise.resolve();
  private lastManualQueueClear = 0;
  private static readonly MANUAL_CLEAR_COOLDOWN_MS = 120_000; // 2min after manual clear, don't auto-fill
  // Cache RID -> filepath for items we enqueue (Liquidsoap doesn't return metadata for queued items)
  private readonly ridToFile = new Map<string, string>();
  private queueService: LiquidsoapQueueService | null = null;

  constructor(
    private readonly telnetClient: TelnetClient,
    private readonly audioMetadataClient: AudioMetadataClient,
    private readonly musicMount: string,
    private readonly libraryRepo?: LibraryRepository,
    private readonly playlistRepo?: PlaylistRepository
  ) {}

  public setQueueService(queueService: LiquidsoapQueueService): void {
    this.queueService = queueService;
  }

  public isConnected(): boolean {
    return this.telnetClient.isConnected();
  }

  private withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queueLock.then(fn, fn);
    this.queueLock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  public async sendCommand(cmd: string, timeoutMs = 10000): Promise<string[]> {
    return this.telnetClient.send(cmd, timeoutMs);
  }

  public async skipTrack(): Promise<void> {
    await this.sendCommand("output.harbor.skip");
  }

  public async clearAndPush(filepath: string): Promise<string | null> {
    await this.queueClear();
    await new Promise((r) => setTimeout(r, 200));
    return this.queuePush(filepath);
  }

  public async pausePlayback(): Promise<void> {
    await this.sendCommand("output.harbor.stop");
  }

  public async startPlayback(): Promise<void> {
    await this.sendCommand("output.harbor.start");
  }

  public async getCurrentFile(): Promise<string | null> {
    try {
      const lines = await this.sendCommand("var.get current_file").catch(() => []);
      const file = lines.length > 0 ? lines[0].trim() : "";
      if (file && !file.includes("ERROR")) return file;
      return null;
    } catch {
      return null;
    }
  }

  public async getCurrentRequestId(): Promise<string | null> {
    try {
      const lines = await this.sendCommand("request.on_air");
      if (
        lines.length > 0 &&
        !lines[0].includes("ERROR:") &&
        !lines[0].includes("unknown command")
      ) {
        const allRids: string[] = [];
        for (const line of lines) {
          for (const part of line.trim().split(/\s+/)) {
            if (part !== "") allRids.push(part);
          }
        }
        if (allRids.length > 0) {
          const sorted = allRids.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
          return sorted[0];
        }
      }

      // Fallback: get current harbor metadata, and resolve its request ID
      const harborLines = await this.sendCommand("output.harbor.metadata").catch(() => []);
      const harborMeta: Record<string, string> = {};
      for (const line of harborLines) {
        const eqIndex = line.indexOf("=");
        if (eqIndex > 0) {
          const key = line.substring(0, eqIndex).trim();
          let value = line.substring(eqIndex + 1).trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          harborMeta[key] = value;
        }
      }

      if (!harborMeta.title) return null;
      return this.getActiveRequestId(harborMeta.title, harborMeta.artist || "");
    } catch {
      return null;
    }
  }

  public async getActiveRequestId(
    currentTitle: string,
    currentArtist: string
  ): Promise<string | null> {
    try {
      const allRidsLines = await this.sendCommand("request.all").catch(() => []);
      const rids: string[] = [];
      for (const line of allRidsLines) {
        for (const part of line.trim().split(/\s+/)) {
          if (part && !Number.isNaN(Number(part))) {
            rids.push(part);
          }
        }
      }

      for (const rid of rids) {
        const meta = await this.getRequestMetadata(rid);
        const normTitle = (meta.title || "").toLowerCase().trim();
        const normArtist = (meta.artist || "").toLowerCase().trim();
        const targetTitle = currentTitle.toLowerCase().trim();
        const targetArtist = currentArtist.toLowerCase().trim();

        if (
          normTitle &&
          targetTitle &&
          (normTitle.includes(targetTitle) || targetTitle.includes(normTitle))
        ) {
          if (
            !targetArtist ||
            normArtist.includes(targetArtist) ||
            targetArtist.includes(normArtist)
          ) {
            return rid;
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  public async getRequestMetadata(rid: string): Promise<Record<string, string>> {
    try {
      const lines = await this.sendCommand(`request.metadata ${rid}`, 5000);
      const meta: Record<string, string> = {};
      for (const line of lines) {
        const eqIndex = line.indexOf("=");
        if (eqIndex > 0) {
          const key = line.substring(0, eqIndex).trim();
          let value = line.substring(eqIndex + 1).trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          // Skip huge fields like lyrics/uslt to keep metadata lean
          if (key === "uslt" || key === "lyrics" || value.length > 500) continue;
          meta[key] = value;
        }
      }

      // In Liquidsoap v2.4+, idle requests have no title/artist metadata.
      // Extract from filename as fallback: "/music/songs/SongTitle - Artist.mp3"
      if (meta.filename && !meta.title) {
        const filename = meta.filename.replace(/\\/g, "/").split("/").pop() || "";
        const noExt = filename.replace(/\.[^.]+$/, "");
        // Pattern: "Title - Artist" or just "Title"
        const dashIdx = noExt.indexOf(" - ");
        if (dashIdx > 0) {
          meta.title = noExt.substring(0, dashIdx).trim();
          meta.artist = noExt.substring(dashIdx + 3).trim();
        } else {
          meta.title = noExt;
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
      // 1. Get metadata directly from output.harbor.metadata
      const harborLines = await this.sendCommand("output.harbor.metadata").catch(() => []);
      const harborMeta: Record<string, string> = {};
      for (const line of harborLines) {
        const eqIndex = line.indexOf("=");
        if (eqIndex > 0) {
          const key = line.substring(0, eqIndex).trim();
          let value = line.substring(eqIndex + 1).trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          harborMeta[key] = value;
        }
      }

      if (!harborMeta.title) {
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

      // 2. Resolve matching request ID
      const artist = harborMeta.artist || "";
      const title = harborMeta.title || "";
      const rid = await this.getActiveRequestId(title, artist);

      let meta = { ...harborMeta };
      let uptimeLines = ["0"];
      let duration = 0;
      let elapsed = 0;

      if (rid) {
        const requestMeta = await this.getRequestMetadata(rid).catch(() => ({}));
        meta = { ...requestMeta, ...meta };
      }

      uptimeLines = await this.sendCommand("uptime").catch(() => ["0"]);

      const filename = meta.filename || meta.initial_uri || "";
      if (filename) {
        duration = await this.getFileDuration(filename);
      }

      let calculatedElapsed = false;
      const remainingLines = await this.sendCommand("output.harbor.remaining").catch(() => []);
      if (remainingLines.length > 0 && duration > 0) {
        const remainingVal = parseFloat(remainingLines[0].trim());
        if (!Number.isNaN(remainingVal) && remainingVal > 0) {
          elapsed = Math.floor(Math.max(0, duration - remainingVal));
          calculatedElapsed = true;
        }
      }

      if (!calculatedElapsed && meta.on_air_timestamp) {
        const startTime = parseFloat(meta.on_air_timestamp);
        if (!Number.isNaN(startTime)) {
          elapsed = Math.floor(Date.now() / 1000 - startTime);
        }
      }

      return {
        connected,
        playing: true,
        currentTrack: rid || "harbor-active",
        artist: meta.artist || null,
        title: meta.title || null,
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
      if (rid) {
        this.lastQueuedRid = rid;
        this.ridToFile.set(rid, filepath);
      }
      return rid;
    } catch {
      return null;
    }
  }

  public async queueList(limit?: number): Promise<{
    items: {
      rid: string;
      type: "song" | "interludio";
      id?: string;
      artist?: string;
      title?: string;
      script?: string;
      file?: string;
      pending?: boolean;
    }[];
    total: number;
  }> {
    let pendingItems: any[] = [];
    if (this.queueService) {
      try {
        const waitingJobs = await this.queueService.getQueue().getWaiting();
        const activeJobs = await this.queueService.getQueue().getActive();
        const pendingJobs = [...activeJobs, ...waitingJobs];

        pendingItems = pendingJobs.map((job) => {
          const { filepath, script } = job.data || {};
          const isInterludio = !!script || (filepath && filepath.includes("/interludios/"));

          let title = "";
          let artist = "";
          if (script) {
            title = script;
          } else if (filepath) {
            const fname = filepath.replace(/\\/g, "/").split("/").pop() || "";
            const noExt = fname.replace(/\.[^.]+$/, "");
            const dashIdx = noExt.indexOf(" - ");
            if (dashIdx > 0) {
              title = noExt.substring(0, dashIdx).trim();
              artist = noExt.substring(dashIdx + 3).trim();
            } else {
              title = noExt;
            }
          }

          return {
            rid: `pending-${job.id}`,
            title: title || "Preparando audio...",
            artist: artist || "",
            type: isInterludio ? ("interludio" as const) : ("song" as const),
            script,
            pending: true,
          };
        });
      } catch (err: any) {
        console.error("[LiquidsoapService] Error fetching pending jobs:", err.message);
      }
    }

    try {
      const lines = await this.sendCommand("queue.queue");
      const rids = lines.length > 0 ? lines[0].split(/\s+/).filter(Boolean) : [];
      const totalLiquidsoap = rids.length;
      const ridsToFetch = limit ? rids.slice(0, limit) : rids;

      let items: any[] = [];

      if (ridsToFetch.length > 0) {
        // Phase 1: resolve filenames from cache (0 telnet calls)
        const ridFilenames: Record<string, string> = {};
        const uncachedRids: string[] = [];

        for (const rid of ridsToFetch) {
          const cached = this.ridToFile.get(rid);
          if (cached) {
            ridFilenames[rid] = cached;
          } else {
            uncachedRids.push(rid);
          }
        }

        // Phase 2: batch fetch uncached RIDs in parallel (only what's missing)
        if (uncachedRids.length > 0) {
          const metas = await Promise.all(
            uncachedRids.map((rid) => this.getRequestMetadata(rid).catch(() => ({})))
          );
          for (let i = 0; i < uncachedRids.length; i++) {
            const meta = metas[i] as Record<string, string>;
            const filename = meta.filename || meta.initial_uri || "";
            if (filename) {
              ridFilenames[uncachedRids[i]] = filename;
              this.ridToFile.set(uncachedRids[i], filename);
            }
          }
        }

        // Phase 3: batch lookup all filenames in SQLite (1 query)
        const allFiles = [...new Set(Object.values(ridFilenames).map(toDbPath))];
        const libTracks = this.libraryRepo!.getTracksByFiles(allFiles);

        // Phase 4: build results with zero extra network calls
        items = ridsToFetch.map((rid) => {
          const filename = ridFilenames[rid] || "";
          const dbFile = toDbPath(filename);
          const libTrack = libTracks.get(dbFile);
          const isInterludio = dbFile.startsWith("interludios/");

          let title = libTrack?.title || "";
          let artist = libTrack?.artist || "";
          let script: string | undefined;

          // Get script from libraryTracks (TTS interludios) or playlistTracks
          if (libTrack?.script) {
            script = libTrack.script;
            title = script;
          } else if (isInterludio && this.playlistRepo && filename) {
            const foundScript = this.playlistRepo.findScriptByFile(dbFile);
            if (foundScript) {
              script = foundScript;
              title = foundScript;
            }
          }

          if (!title && filename) {
            const fname = filename.replace(/\\/g, "/").split("/").pop() || "";
            const noExt = fname.replace(/\.[^.]+$/, "");
            const dashIdx = noExt.indexOf(" - ");
            if (dashIdx > 0) {
              title = noExt.substring(0, dashIdx).trim();
              if (!artist) artist = noExt.substring(dashIdx + 3).trim();
            } else {
              title = noExt;
            }
          }

          if (!rids.includes(rid)) this.ridToFile.delete(rid);

          // Simplified response for TTS interludios
          if (isInterludio && script) {
            return {
              rid,
              type: "interludio" as const,
              script,
            };
          }

          return {
            rid,
            id: libTrack?.id,
            artist,
            title: title || filename || rid,
            type: isInterludio ? ("interludio" as const) : ("song" as const),
            script,
            file: filename || undefined,
          };
        });
      }

      // Combine Liquidsoap items (already enqueued/playing next) with pending items (synthesizing/waiting)
      // Since pending items are enqueued later, they go to the end
      const combined = [...items, ...pendingItems];
      const finalItems = limit ? combined.slice(0, limit) : combined;
      const total = totalLiquidsoap + pendingItems.length;

      return { items: finalItems, total };
    } catch {
      // In case sendCommand or parsing fails, still return pending items if they exist
      return { items: pendingItems, total: pendingItems.length };
    }
  }

  private async resolveTrack(rid: string): Promise<{
    rid: string;
    type: "song" | "interludio";
    id?: string;
    artist?: string;
    title?: string;
    script?: string;
  } | null> {
    // Get filename from cache or telnet
    let filename = this.ridToFile.get(rid);
    if (!filename) {
      const meta = await this.getRequestMetadata(rid).catch(() => ({}));
      filename =
        (meta as Record<string, string>).filename ||
        (meta as Record<string, string>).initial_uri ||
        "";
      if (filename) this.ridToFile.set(rid, filename);
    }
    if (!filename) return null;

    const dbFile = toDbPath(filename);
    const libTracks = this.libraryRepo!.getTracksByFiles([dbFile]);
    const libTrack = libTracks.get(dbFile);
    const isInterludio = dbFile.startsWith("interludios/");

    let title = libTrack?.title || "";
    let artist = libTrack?.artist || "";
    let script: string | undefined;

    if (libTrack?.script) {
      script = libTrack.script;
      title = script;
    } else if (isInterludio && this.playlistRepo && filename) {
      const foundScript = this.playlistRepo.findScriptByFile(dbFile);
      if (foundScript) {
        script = foundScript;
        title = foundScript;
      }
    }

    if (!title && filename) {
      const fname = filename.replace(/\\/g, "/").split("/").pop() || "";
      const noExt = fname.replace(/\.[^.]+$/, "");
      const dashIdx = noExt.indexOf(" - ");
      if (dashIdx > 0) {
        title = noExt.substring(0, dashIdx).trim();
        if (!artist) artist = noExt.substring(dashIdx + 3).trim();
      } else {
        title = noExt;
      }
    }

    if (isInterludio && script) {
      return { rid, type: "interludio", script };
    }

    return {
      rid,
      id: libTrack?.id,
      artist,
      title: title || filename || rid,
      type: isInterludio ? "interludio" : "song",
      script,
    };
  }

  public async getCurrentTrack(): Promise<{
    rid: string;
    type: "song" | "interludio";
    id?: string;
    artist?: string;
    title?: string;
    script?: string;
    duration: string;
    elapsed: string;
  } | null> {
    try {
      const rid = await this.getCurrentRequestId();
      if (!rid) return null;

      const track = await this.resolveTrack(rid);
      if (!track) return null;

      // Get duration and elapsed
      const harborLines = await this.sendCommand("output.harbor.remaining").catch(() => []);
      const remaining = parseFloat(harborLines[0]?.trim() || "0");

      const meta = (await this.getRequestMetadata(rid).catch(() => ({}))) as Record<string, string>;
      const filename = meta.filename || "";
      const duration = filename ? await this.getFileDuration(filename) : 0;
      const elapsed = duration > 0 && remaining > 0 ? Math.floor(duration - remaining) : 0;

      const formatTime = (s: number): string => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
      };

      return {
        ...track,
        duration: formatTime(duration),
        elapsed: formatTime(elapsed),
      };
    } catch {
      return null;
    }
  }

  public async queueRemove(rid: string): Promise<boolean> {
    try {
      await this.sendCommand(`queue.remove ${rid}`);
      this.ridToFile.delete(rid);
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
        const metas: Record<string, string>[] = await Promise.all(
          queued.map((r) => this.getRequestMetadata(r).catch((): Record<string, string> => ({})))
        );
        const uris = metas.map((m) => m.initial_uri || m.filename || "").filter(Boolean);
        const safeIndex = Math.max(0, Math.min(index, uris.length));
        uris.splice(safeIndex, 0, filepath);

        // Clear via queue.remove (v2.4+ has no queue.clear)
        for (const rid of queued) {
          await this.sendCommand(`queue.remove ${rid}`).catch(() => {});
        }
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
      // In Liquidsoap v2.4+, there's no queue.clear telnet command.
      // Get all rids and remove them one by one.
      const lines = await this.sendCommand("queue.queue");
      if (lines.length === 0) return;
      const rids = lines[0].split(/\s+/).filter(Boolean);
      for (const rid of rids) {
        await this.sendCommand(`queue.remove ${rid}`).catch(() => {});
        this.ridToFile.delete(rid);
      }
      this.lastManualQueueClear = Date.now();
      console.log(`[LiquidsoapService] Queue cleared: removed ${rids.length} items`);
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
      await this.queueClear();
      await new Promise((r) => setTimeout(r, 200));
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
