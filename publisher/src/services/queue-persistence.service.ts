import type { PlaybackStateRepository } from "../repositories/sqlite/playback-state.repo";
import type { BuncasterService } from "./buncaster.service";

const RESTORE_RETRY_INTERVAL = 2000;
const RESTORE_MAX_RETRIES = 30;
const RESTORE_DELAY = 3000;
const PERSIST_INTERVAL = 15000;

interface LibraryServiceLike {
  updateLastPlayedByFile: (file: string) => void;
}

export class QueuePersistenceService {
  private persistTimer: Timer | null = null;
  private lastPlayedFile: string | null = null;

  constructor(
    private readonly buncasterService: BuncasterService,
    private readonly playbackStateRepo: PlaybackStateRepository,
    private readonly libraryService: LibraryServiceLike
  ) {}

  public start(): void {
    setTimeout(() => this.restore(), RESTORE_DELAY);
    this.persistTimer = setInterval(() => this.persist(), PERSIST_INTERVAL);
  }

  public stop(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private async restore(): Promise<void> {
    try {
      const snapshot = this.playbackStateRepo.getQueueSnapshot();
      if (!snapshot) {
        console.log("[QueuePersistence] No saved queue found. Starting fresh.");
        return;
      }

      console.log(`[QueuePersistence] Queue found: ${snapshot.count} items`);

      const currentElapsed = snapshot.currentElapsed;
      const currentDuration = snapshot.currentDuration;

      if (currentDuration > 0 && currentElapsed >= currentDuration) {
        console.log("[QueuePersistence] Previous track would have ended. Starting fresh.");
        this.playbackStateRepo.clear();
        return;
      }

      const files = snapshot.files.filter(Boolean);

      // Filter out interludios from restored queue (they lose their scripts on restore)
      const songsOnly = files.filter((f) => !f.includes("interludios/"));

      for (let attempt = 0; attempt < RESTORE_MAX_RETRIES; attempt++) {
        if (this.buncasterService.isConnected()) {
          console.log(`[QueuePersistence] Restoring queue: ${songsOnly.length} songs (filtered ${files.length - songsOnly.length} interludios)`);

          for (const file of songsOnly) {
            await this.buncasterService.queuePush(file).catch(() => {});
            await new Promise((r) => setTimeout(r, 100));
          }

          await new Promise((r) => setTimeout(r, 500));
          await this.buncasterService.skipTrack();
          await new Promise((r) => setTimeout(r, 800));
          return;
        }
        await new Promise((r) => setTimeout(r, RESTORE_RETRY_INTERVAL));
      }
      console.log("[QueuePersistence] Buncaster not available after 60s, skipping restore.");
    } catch (err: any) {
      console.error("[QueuePersistence] Error during restore:", err.message);
    }
  }

  private async persist(): Promise<void> {
    try {
      const status = await this.buncasterService.getStreamStatus();
      if (!status.playing) return;

      const file = await this.buncasterService.getCurrentFile();
      if (!file) return;

      if (file !== this.lastPlayedFile) {
        this.lastPlayedFile = file;
        this.libraryService.updateLastPlayedByFile(file);
      }

      const { items } = await this.buncasterService.queueList();
      const queueFiles: string[] = [file];
      for (const item of items.slice(1)) {
        if (item.file && !item.file.includes("interludios/")) {
          queueFiles.push(item.file);
        }
      }

      let h = 5381;
      for (const f of queueFiles) {
        for (let i = 0; i < f.length; i++) h = ((h << 5) + h + f.charCodeAt(i)) | 0;
      }
      const hash = (h >>> 0).toString(36);

      if (!this.playbackStateRepo.hasSnapshot(hash)) {
        this.playbackStateRepo.saveSnapshot(hash, queueFiles, status.elapsed, status.duration);
      } else {
        this.playbackStateRepo.updateElapsed(status.elapsed);
      }
    } catch (err: any) {
      console.error(`[QueuePersistence] error:`, err.message);
    }
  }
}
