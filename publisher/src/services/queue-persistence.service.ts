import type { PlaybackStateRepository } from "../repositories/sqlite/playback-state.repo";
import type { LiquidsoapService } from "./liquidsoap.service";

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
    private readonly liquidsoapService: LiquidsoapService,
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

      for (let attempt = 0; attempt < RESTORE_MAX_RETRIES; attempt++) {
        if (this.liquidsoapService.isConnected()) {
          console.log(`[QueuePersistence] Restoring queue: ${files.length} items`);

          for (const file of files) {
            await this.liquidsoapService.queuePush(file).catch(() => {});
            await new Promise((r) => setTimeout(r, 100));
          }

          await new Promise((r) => setTimeout(r, 500));
          await this.liquidsoapService.sendCommand("queue.skip");
          await new Promise((r) => setTimeout(r, 800));

          const currentRid = await this.liquidsoapService.getCurrentRequestId();
          if (currentRid) {
            const seekPos = Math.max(0, currentElapsed);
            const ok = await this.liquidsoapService.requestSeek(currentRid, seekPos);
            console.log(
              `[QueuePersistence] Seek to ${Math.round(seekPos)}s: ${ok ? "OK" : "failed, playing from start"}`
            );
          }
          return;
        }
        await new Promise((r) => setTimeout(r, RESTORE_RETRY_INTERVAL));
      }
      console.log("[QueuePersistence] Liquidsoap not available after 60s, skipping restore.");
    } catch (err: any) {
      console.error("[QueuePersistence] Error during restore:", err.message);
    }
  }

  private async persist(): Promise<void> {
    try {
      const status = await this.liquidsoapService.getStreamStatus();
      if (!status.playing || !status.metadata) return;

      const file = await this.liquidsoapService.getCurrentFile();
      if (!file) return;

      if (file !== this.lastPlayedFile) {
        this.lastPlayedFile = file;
        this.libraryService.updateLastPlayedByFile(file);
      }

      const queueLines = await this.liquidsoapService.sendCommand("queue.queue").catch(() => []);
      const rids = queueLines.length > 0 ? queueLines[0].split(/\s+/).filter(Boolean) : [];

      const queueFiles: string[] = [file];
      if (rids.length > 0) {
        const { items } = await this.liquidsoapService.queueList();
        for (const item of items.slice(1)) {
          if (item.file) queueFiles.push(item.file);
        }
      }

      let h = 5381;
      for (const rid of rids) {
        for (let i = 0; i < rid.length; i++) h = ((h << 5) + h + rid.charCodeAt(i)) | 0;
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
