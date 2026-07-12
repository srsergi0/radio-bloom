import { promises as fsPromises, statSync } from "node:fs";
import { join } from "node:path";
import { type Job, Queue, Worker } from "bullmq";
import { EdgeTTS } from "edge-tts-universal";
import type { AudioMetadataClient } from "../infrastructure/audio-metadata.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";

function parseRedisUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "localhost",
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      db:
        parsed.pathname && parsed.pathname !== "/"
          ? parseInt(parsed.pathname.slice(1), 10) || 0
          : 0,
      maxRetriesPerRequest: null,
    };
  } catch {
    return { host: "localhost", port: 6379, maxRetriesPerRequest: null };
  }
}

export interface QueueAddJob {
  filepath?: string;
  script?: string;
  voice?: string;
}

export class BuncasterQueueService {
  private queue: Queue;
  private worker: Worker | null = null;
  private queueName = "buncaster-queue";
  private connectionOptions: any;

  constructor(
    private queuePush: (filepath: string, script?: string) => Promise<string | null>,
    private musicDir: string,
    private libraryRepo?: LibraryRepository,
    private audioMetadataClient?: AudioMetadataClient
  ) {
    const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/0";
    this.connectionOptions = parseRedisUrl(REDIS_URL);

    this.queue = new Queue(this.queueName, {
      connection: this.connectionOptions,
      defaultJobOptions: {
        removeOnComplete: { age: 60, count: 50 },
        removeOnFail: { age: 300, count: 20 },
      },
    });
  }

  startWorker(): void {
    this.worker = new Worker(
      this.queueName,
      async (job: Job<QueueAddJob>) => {
        const { filepath, script, voice } = job.data;

        if (filepath) {
          const rid = await this.queuePush(filepath, script);
          if (!rid) throw new Error(`Failed to push ${filepath} to Buncaster`);
          return { rid, filepath };
        }

        if (script) {
          await job.log("Synthesizing TTS audio...");
          const audioPath = await this.synthesize(script, voice);
          if (!audioPath) throw new Error("TTS synthesis failed");
          await job.log(`TTS ready: ${audioPath}`);

          // Extract metadata from the synthesized file
          await job.log("Extracting metadata...");
          const stat = statSync(audioPath);
          const size = stat.size;
          let duration = 0;
          if (this.audioMetadataClient) {
            try {
              const meta = await this.audioMetadataClient.extractMetadata(audioPath);
              duration = meta.duration || 0;
            } catch {}
          }
          await job.log(`Metadata: size=${size}, duration=${duration}`);

          // Save to library with full metadata
          const normalized = audioPath.replace(/\\/g, "/");
          const relativePath = normalized.replace(/^.*?(interludios\/)/, "interludios/");
          if (this.libraryRepo) {
            this.libraryRepo.upsertTtsInterludio(relativePath, script, duration, size);
            await job.log(`Saved to library: ${relativePath}`);
          } else {
            await job.log("No libraryRepo, skipping save");
          }

          // Pass script to queuePush so BuncasterService can track it
          const rid = await this.queuePush(relativePath, script);
          if (!rid) throw new Error(`Failed to push TTS to Buncaster`);
          await job.log(`Queued to Buncaster: rid=${rid}`);
          return { rid, filepath: audioPath };
        }

        throw new Error("Job requires filepath or script");
      },
      {
        connection: this.connectionOptions,
        concurrency: 1,
        limiter: { max: 1, duration: 200 },
      }
    );

    this.worker.on("completed", (job) => {
      console.log(`[BuncasterQueue] Job ${job.id} completed: ${job.data.filepath || "TTS"}`);
    });

    this.worker.on("failed", (job, err) => {
      console.error(`[BuncasterQueue] Job ${job?.id} failed: ${err.message}`);
    });
  }

  async add(filepath: string): Promise<Job<QueueAddJob>> {
    return this.queue.add(
      "play",
      { filepath },
      { jobId: `bcq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }
    );
  }

  async addTts(script: string, voice?: string): Promise<Job<QueueAddJob>> {
    return this.queue.add(
      "tts",
      { script, voice },
      { jobId: `bcq-tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }
    );
  }

  private async synthesize(scriptText: string, voice?: string): Promise<string | null> {
    const activeVoice = voice || process.env.AI_DJ_VOICE || "es-ES-AlvaroNeural";
    try {
      const filename = `ai_dj_pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`;
      const interludiosDir = join(this.musicDir, "interludios");
      const filePath = join(interludiosDir, filename);

      const tts = new EdgeTTS(scriptText, activeVoice);
      const result = await tts.synthesize();
      const arrayBuffer = await result.audio.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await fsPromises.writeFile(filePath, buffer);

      console.log(`[BuncasterQueue] TTS synthesized: ${filePath}`);
      return filePath;
    } catch (err: any) {
      console.error("[BuncasterQueue] TTS failed:", err.message);
      return null;
    }
  }

  async getWaiting(): Promise<Job<QueueAddJob>[]> {
    return this.queue.getWaiting();
  }

  async getJobCounts() {
    return this.queue.getJobCounts("waiting", "active", "completed", "failed");
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
  }
}
