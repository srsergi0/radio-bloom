import type { StreamStatus } from "../domain/types";
import type { AudioMetadataClient } from "../infrastructure/audio-metadata.client";
import type { BuncasterClient } from "../infrastructure/buncaster.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlaylistRepository } from "../repositories/sqlite/playlist.repo";
import type { BuncasterQueueService } from "./buncaster-queue.service";

function toDbPath(filepath: string): string {
  const forwardSlash = filepath.replace(/\\/g, "/");
  const match = forwardSlash.match(/(?:^|\/)(songs|interludios)\/(.+)$/);
  return match ? `${match[1]}/${match[2]}` : forwardSlash;
}

function toContainerPath(filepath: string): string {
  // "songs/file.mp3" → "/app/music/songs/file.mp3"
  // "interludios/file.mp3" → "/app/music/interludios/file.mp3"
  if (filepath.startsWith("/app/music/")) return filepath;
  return `/app/music/${filepath}`;
}

function extractTitleArtist(filename: string): { title: string; artist: string } {
  const fname = filename.replace(/\\/g, "/").split("/").pop() || "";
  const noExt = fname.replace(/\.[^.]+$/, "");
  const dashIdx = noExt.indexOf(" - ");
  if (dashIdx > 0) {
    return {
      title: noExt.substring(0, dashIdx).trim(),
      artist: noExt.substring(dashIdx + 3).trim(),
    };
  }
  return { title: noExt, artist: "" };
}

export class BuncasterService {
  private lastManualQueueClear = 0;
  private static readonly MANUAL_CLEAR_COOLDOWN_MS = 120_000;
  private static readonly SCRIPT_CACHE_MAX = 200;
  private queueService: BuncasterQueueService | null = null;
  // Cache for TTS interludios scripts (Buncaster doesn't store scripts)
  private readonly indexToScript = new Map<number, string>();
  private readonly fileToScript = new Map<string, string>();

  constructor(
    private readonly buncasterClient: BuncasterClient,
    private readonly audioMetadataClient: AudioMetadataClient,
    private readonly musicMount: string,
    private readonly libraryRepo?: LibraryRepository,
    private readonly playlistRepo?: PlaylistRepository
  ) {}

  public setQueueService(queueService: BuncasterQueueService): void {
    this.queueService = queueService;
  }

  public isConnected(): boolean {
    return this.buncasterClient.isConnected();
  }

  public getHost(): string {
    return this.buncasterClient.getHost();
  }

  public getPort(): number {
    return this.buncasterClient.getPort();
  }

  public getAdminUser(): string {
    return this.buncasterClient.getAdminUser();
  }

  public getAdminPass(): string {
    return this.buncasterClient.getAdminPass();
  }

  // ── Playback Controls ───────────────────────────────────

  public async skipTrack(): Promise<void> {
    await this.buncasterClient.skip();
  }

  public async pausePlayback(): Promise<void> {
    await this.buncasterClient.toggleFallback();
  }

  public async startPlayback(): Promise<void> {
    await this.buncasterClient.toggleFallback();
  }

  public async getCurrentFile(): Promise<string | null> {
    try {
      const track = await this.buncasterClient.getCurrentTrack();
      return track?.file || null;
    } catch {
      return null;
    }
  }

  // ── Stream Status ───────────────────────────────────────

  public async getStreamStatus(): Promise<StreamStatus> {
    const connected = this.isConnected();
    try {
      const status = await this.buncasterClient.getStatus();
      const current = status.currentTrack;

      if (!current) {
        return {
          connected,
          playing: false,
          currentTrack: null,
          artist: null,
          title: null,
          uptime: String(status.uptime || 0),
          duration: 0,
          elapsed: 0,
        };
      }

      // Try to enrich with library metadata
      let artist = current.artist || "";
      let title = current.title || "";

      if (current.file && this.libraryRepo) {
        const dbFile = toDbPath(current.file);
        const tracks = this.libraryRepo.getTracksByFiles([dbFile]);
        const libTrack = tracks.get(dbFile);
        if (libTrack) {
          artist = libTrack.artist || artist;
          title = libTrack.title || title;
        }
      }

      return {
        connected,
        playing: true,
        currentTrack: current.file,
        artist: artist || null,
        title: title || null,
        uptime: String(status.uptime || 0),
        duration: Math.floor(current.duration || 0),
        elapsed: Math.floor(current.elapsed || 0),
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

  // ── Queue Management ────────────────────────────────────

  public async queuePush(filepath: string, script?: string): Promise<string | null> {
    try {
      const containerPath = toContainerPath(filepath);
      const success = await this.buncasterClient.pushToQueue(containerPath);
      if (!success) return null;

      // Store script if it's an interludio
      if (script) {
        this.fileToScript.set(containerPath, script);
      }

      // Return a synthetic RID (Buncaster uses indices, but we need to return something)
      const queue = await this.buncasterClient.getQueue();
      const lastItem = queue[queue.length - 1];
      if (lastItem) {
        const rid = String(lastItem.index);
        if (script) {
          this.indexToScript.set(lastItem.index, script);
        }
        return rid;
      }
      return null;
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
    // Get pending items from BullMQ queue
    let pendingItems: any[] = [];
    if (this.queueService) {
      try {
        const waitingJobs = await this.queueService.getQueue().getWaiting();
        const activeJobs = await this.queueService.getQueue().getActive();
        const pendingJobs = [...activeJobs, ...waitingJobs];

        pendingItems = pendingJobs.map((job) => {
          const { filepath, script } = job.data || {};
          const isInterludio = !!script || (filepath && filepath.includes("/interludios/"));
          const { title, artist } = filepath ? extractTitleArtist(filepath) : { title: "", artist: "" };

          return {
            rid: `pending-${job.id}`,
            title: script || title || "Preparando audio...",
            artist: artist || "",
            type: isInterludio ? ("interludio" as const) : ("song" as const),
            script,
            pending: true,
          };
        });
      } catch (err: any) {
        console.error("[BuncasterService] Error fetching pending jobs:", err.message);
      }
    }

    // Get queue from Buncaster
    try {
      const queue = await this.buncasterClient.getQueue();

      // Periodically sync caches to prevent memory leak (every ~30s)
      if (Math.random() < 0.05) {
        this.syncScriptCaches();
      }

      const items = queue.map((item) => {
        const dbFile = toDbPath(item.file);
        const isInterludio = dbFile.startsWith("interludios/");

        // Check for stored script
        const script = this.indexToScript.get(item.index) || this.fileToScript.get(item.file);

        // Try to get metadata from library
        let artist = item.artist || "";
        let title = item.title || "";

        if (this.libraryRepo) {
          const tracks = this.libraryRepo.getTracksByFiles([dbFile]);
          const libTrack = tracks.get(dbFile);
          if (libTrack) {
            artist = libTrack.artist || artist;
            title = libTrack.title || title;
          }
        }

        // Fallback: extract from filename
        if (!title && item.file) {
          const extracted = extractTitleArtist(item.file);
          title = extracted.title;
          artist = artist || extracted.artist;
        }

        if (isInterludio && script) {
          return {
            rid: String(item.index),
            type: "interludio" as const,
            script,
          };
        }

        return {
          rid: String(item.index),
          id: dbFile,
          artist,
          title: title || item.file || String(item.index),
          type: isInterludio ? ("interludio" as const) : ("song" as const),
          script,
          file: item.file || undefined,
        };
      });

      const finalItems = limit ? [...items, ...pendingItems].slice(0, limit) : [...items, ...pendingItems];
      return { items: finalItems, total: queue.length + pendingItems.length };
    } catch {
      return { items: pendingItems, total: pendingItems.length };
    }
  }

  public async queueRemove(rid: string): Promise<boolean> {
    try {
      const index = parseInt(rid, 10);
      if (Number.isNaN(index)) return false;
      const success = await this.buncasterClient.removeFromQueue(index);
      if (success) {
        this.indexToScript.delete(index);
      }
      return success;
    } catch {
      return false;
    }
  }

  public async queueInsert(index: number, filepath: string, script?: string): Promise<boolean> {
    try {
      // Buncaster doesn't have a direct insert-at-index, so we:
      // 1. Push to queue (goes to end)
      // 2. Move to desired position
      const containerPath = toContainerPath(filepath);
      const success = await this.buncasterClient.pushToQueue(containerPath);
      if (!success) return false;

      const queue = await this.buncasterClient.getQueue();
      const newIndex = queue.length - 1;

      if (script) {
        this.indexToScript.set(newIndex, script);
        this.fileToScript.set(containerPath, script);
      }

      if (newIndex !== index) {
        await this.buncasterClient.moveInQueue(newIndex, index);
      }

      return true;
    } catch {
      return false;
    }
  }

  public async queueClear(manual = true): Promise<void> {
    try {
      await this.buncasterClient.clearQueue();
      this.indexToScript.clear();
      this.fileToScript.clear();
      if (manual) {
        this.lastManualQueueClear = Date.now();
      }
      console.log("[BuncasterService] Queue cleared");
    } catch {}
  }

  /**
   * Sync script caches with current queue state.
   * Removes entries for tracks that are no longer in the queue.
   */
  private async syncScriptCaches(): Promise<void> {
    try {
      const queue = await this.buncasterClient.getQueue();
      const activeFiles = new Set(queue.map((item) => item.file));
      const activeIndices = new Set(queue.map((item) => item.index));

      // Clean fileToScript: remove entries for files not in queue
      for (const [file] of this.fileToScript) {
        if (!activeFiles.has(file)) {
          this.fileToScript.delete(file);
        }
      }

      // Clean indexToScript: remove entries for indices not in queue
      for (const [index] of this.indexToScript) {
        if (!activeIndices.has(index)) {
          this.indexToScript.delete(index);
        }
      }

      // Enforce max cache size (FIFO eviction)
      if (this.fileToScript.size > BuncasterService.SCRIPT_CACHE_MAX) {
        const entries = Array.from(this.fileToScript.entries());
        const toRemove = entries.slice(0, entries.length - BuncasterService.SCRIPT_CACHE_MAX);
        for (const [file] of toRemove) {
          this.fileToScript.delete(file);
        }
      }
    } catch {}
  }

  public isManualClearActive(): boolean {
    return Date.now() - this.lastManualQueueClear < BuncasterService.MANUAL_CLEAR_COOLDOWN_MS;
  }

  public async playFileNow(filepath: string): Promise<boolean> {
    try {
      await this.queueClear();
      const rid = await this.queuePush(filepath);
      if (!rid) return false;
      await new Promise((r) => setTimeout(r, 500));
      await this.buncasterClient.skip();
      return true;
    } catch {
      return false;
    }
  }

  public async playFilesNow(filepaths: string[]): Promise<boolean> {
    try {
      await this.queueClear();
      for (const filepath of filepaths) {
        await this.queuePush(filepath);
      }
      await new Promise((r) => setTimeout(r, 500));
      await this.buncasterClient.skip();
      return true;
    } catch {
      return false;
    }
  }

  public async reloadPlaylist(): Promise<void> {
    await this.buncasterClient.shufflePlaylist();
  }

  public async requestSeek(_rid: string, _position: number): Promise<boolean> {
    return false;
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
      const track = await this.buncasterClient.getCurrentTrack();
      if (!track) return null;

      const dbFile = toDbPath(track.file);
      const isInterludio = dbFile.startsWith("interludios/");
      const script = this.fileToScript.get(track.file);

      let artist = track.artist || "";
      let title = track.title || "";

      if (this.libraryRepo) {
        const tracks = this.libraryRepo.getTracksByFiles([dbFile]);
        const libTrack = tracks.get(dbFile);
        if (libTrack) {
          artist = libTrack.artist || artist;
          title = libTrack.title || title;
        }
      }

      if (!title && track.file) {
        const extracted = extractTitleArtist(track.file);
        title = extracted.title;
        artist = artist || extracted.artist;
      }

      const formatTime = (s: number): string => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
      };

      return {
        rid: track.file,
        type: isInterludio ? "interludio" : "song",
        id: dbFile,
        artist,
        title: title || track.file,
        script,
        duration: formatTime(track.duration || 0),
        elapsed: formatTime(track.elapsed || 0),
      };
    } catch {
      return null;
    }
  }
}
