import { Queue, Worker, type Job } from "bullmq";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/0";
const DATA_DIR = process.env.DATA_DIR || "./data";
const MUSIC_DIR = process.env.MUSIC_DIR || "../music";

function parseRedisUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || "localhost",
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      db: parsed.pathname && parsed.pathname !== "/" ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
      maxRetriesPerRequest: null,
    };
  } catch (err) {
    console.error("[TorrentService] Error parsing REDIS_URL, using default fallback:", err);
    return {
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }
}

export class TorrentService {
  private queue: Queue;
  private worker: Worker | null = null;
  private queueName = "torrent-downloads";
  private connectionOptions: any;

  constructor() {
    this.connectionOptions = parseRedisUrl(REDIS_URL);

    // Initialize BullMQ Queue
    this.queue = new Queue(this.queueName, {
      connection: this.connectionOptions,
    });
  }

  /**
   * Start the BullMQ Worker to process downloads
   */
  startWorker(): void {
    const tempDir = path.resolve(DATA_DIR, "downloads-temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const musicSongsDir = path.resolve(MUSIC_DIR, "songs");
    if (!fs.existsSync(musicSongsDir)) {
      fs.mkdirSync(musicSongsDir, { recursive: true });
    }

    console.log(`[TorrentService] Starting worker. Temp downloads: ${tempDir}, Target songs: ${musicSongsDir}`);

    this.worker = new Worker(
      this.queueName,
      async (job: Job) => {
        const { magnet, name } = job.data;
        const safeName = name.replace(/[^a-zA-Z0-9 -_]/g, "").slice(0, 50).trim() || "download";
        const downloadPath = path.join(tempDir, `${job.id}-${safeName}`);
        
        if (!fs.existsSync(downloadPath)) {
          fs.mkdirSync(downloadPath, { recursive: true });
        }

        await job.log(`Iniciando descarga de: ${name}`);
        await job.log(`Carpeta temporal: ${downloadPath}`);

        // Spawn aria2c process
        return new Promise<void>((resolve, reject) => {
          const child = spawn("aria2c", [
            `--dir=${downloadPath}`,
            "--seed-time=0",
            "--bt-stop-timeout=300",
            "--max-connection-per-server=16",
            "--split=16",
            "--continue=true",
            "--summary-interval=5",
            magnet,
          ]);

          // Safety timeout: kill if aria2c hangs for 10 minutes
          const safetyTimer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("aria2c timed out after 10 minutes"));
          }, 600000);

          child.stdout.on("data", async (data) => {
            const lines = data.toString().split(/\r?\n/);
            for (const line of lines) {
              if (line.trim()) {
                await job.log(line);

                // Parse progress percentage
                // aria2c prints summary like: [#abcdef 1.2MiB/4.5MiB(26%) CN:1 SD:2 DL:120KiB]
                const progressMatch = line.match(/\((\d+)%\)/);
                if (progressMatch) {
                  const percent = parseInt(progressMatch[1], 10);
                  await job.updateProgress(percent);
                }
              }
            }
          });

          child.stderr.on("data", async (data) => {
            const lines = data.toString().split(/\r?\n/);
            for (const line of lines) {
              if (line.trim()) {
                await job.log(`[ERROR] ${line}`);
              }
            }
          });

          child.on("error", async (err: any) => {
            clearTimeout(safetyTimer);
            await job.log(`Error al lanzar aria2c: ${err.message}`);
            await fs.promises.rm(downloadPath, { recursive: true, force: true }).catch(() => {});
            reject(new Error(`aria2c execution failed: ${err.message}. Ensure aria2 is installed.`));
          });

          child.on("close", async (code) => {
            clearTimeout(safetyTimer);
            if (code !== 0) {
              await fs.promises.rm(downloadPath, { recursive: true, force: true }).catch(() => {});
              reject(new Error(`aria2c exited with code ${code}`));
              return;
            }

            await job.log("Descarga completada por aria2c. Escaneando archivos de audio...");
            try {
              // Recursively scan for audio files and move them to final destination
              const audioFiles = findAudioFiles(downloadPath);
              await job.log(`Se encontraron ${audioFiles.length} archivos de audio.`);

              // Use the parent folder of the first audio file as album name
              const albumFolder = path.basename(path.dirname(audioFiles[0])) || job.data.name;
              const albumDir = path.join(musicSongsDir, albumFolder);
              await fs.promises.mkdir(albumDir, { recursive: true });

              for (const file of audioFiles) {
                const baseName = path.basename(file);
                const safeFile = baseName.replace(/[^a-zA-Z0-9.-_ ]/g, "_");
                const dest = path.join(albumDir, safeFile);

                await job.log(`Moviendo ${baseName} -> ${albumFolder}/${safeFile}`);
                try {
                  await fs.promises.rename(file, dest);
                } catch {
                  // Cross-device fallback
                  await fs.promises.copyFile(file, dest);
                }
              }

              // Cleanup temporary download folder
              await fs.promises.rm(downloadPath, { recursive: true, force: true });
              await job.log("Limpieza de carpeta temporal completada.");
              resolve();
            } catch (err: any) {
              await job.log(`Error en procesamiento de archivos: ${err.message}`);
              reject(err);
            }
          });
        });
      },
      { connection: this.connectionOptions, concurrency: 1 }
    );

    this.worker.on("active", (job) => {
      console.log(`[TorrentWorker] Job active: ${job.id} - ${job.data.name}`);
    });

    this.worker.on("completed", (job) => {
      console.log(`[TorrentWorker] Job completed: ${job.id} - ${job.data.name}`);
    });

    this.worker.on("failed", (job, err) => {
      console.error(`[TorrentWorker] Job failed: ${job?.id} - ${job?.data.name}. Error: ${err.message}`);
    });
  }

  /**
   * Search torrents on PirateBay (apibay.org)
   */
  async search(query: string, limit = 10): Promise<TorrentResult[]> {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=100`;
    const headers = { "User-Agent": "Mozilla/5.0" };

    try {
      const response = await fetch(url, { headers });
      const data = (await response.json()) as any[];

      if (!Array.isArray(data) || data.length === 0 || (data.length === 1 && data[0].id === "0")) {
        return [];
      }

      const trackers = [
        "udp://tracker.coppersurfer.tk:6969/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://opentracker.i2p.rocks:6969/announce",
        "udp://tracker.internetwarriors.net:12040/announce",
        "udp://tracker.leechers-paradise.org:6969/announce",
        "udp://coppersurfer.tk:6969/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.cyberia.is:6969/announce",
      ];
      const trackersStr = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join("");

      return data
        .slice(0, limit)
        .map((item: any) => ({
          name: item.name || "N/A",
          seeds: parseInt(item.seeders || "0", 10),
          leechers: parseInt(item.leechers || "0", 10),
          size: Math.round((parseInt(item.size || "0", 10) / (1024 * 1024)) * 10) / 10, // MB
          infoHash: item.info_hash || "",
          magnet: `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}${trackersStr}`,
        }));
    } catch (error) {
      console.error("[TorrentService] Search error:", error);
      return [];
    }
  }

  /**
   * Queue download
   */
  async queueDownload(magnet: string, name: string) {
    const job = await this.queue.add(
      "download",
      { magnet, name },
      {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      }
    );
    return job;
  }

  /**
   * Get job status by ID
   */
  async getJobStatus(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    return {
      id: job.id,
      name: job.data.name,
      magnet: job.data.magnet,
      status: await job.getState(),
      progress: job.progress,
      error: job.failedReason,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    };
  }

  /**
   * Get overall queue stats
   */
  async getQueueStats(): Promise<QueueStats> {
    const [pending, active, completed, failed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
    ]);

    return {
      pending,
      downloading: active,
      completed,
      failed,
    };
  }

  /**
   * List jobs
   */
  async listJobs(limit = 20) {
    const jobs = await this.queue.getJobs(["waiting", "active", "completed", "failed"], 0, limit - 1, true);
    
    return Promise.all(
      jobs.map(async (job) => ({
        id: job.id,
        name: job.data.name,
        magnet: job.data.magnet,
        status: await job.getState(),
        progress: job.progress,
        error: job.failedReason,
        createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
        startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      }))
    );
  }

  /**
   * Get job logs
   */
  async getJobLogs(jobId: string) {
    return this.queue.getJobLogs(jobId);
  }

  /**
   * Cancel/Remove a job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    
    const state = await job.getState();
    if (state === "active") {
      try {
        await job.discard();
      } catch {}
    }
    await job.remove();
    return true;
  }

  /**
   * Get the underlying queue instance (for bull-board)
   */
  getQueue() {
    return this.queue;
  }

  /**
   * Close connections
   */
  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

// Types
export interface TorrentResult {
  name: string;
  seeds: number;
  leechers: number;
  size: number; // MB
  infoHash: string;
  magnet: string;
}

export interface TorrentJobData {
  magnet: string;
  name: string;
}

export interface QueueStats {
  pending: number;
  downloading: number;
  completed: number;
  failed: number;
}

// Helper function to recursively find all audio files in a folder
function findAudioFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findAudioFiles(filePath));
    } else {
      const ext = path.extname(filePath).toLowerCase();
      if ([".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus"].includes(ext)) {
        results.push(filePath);
      }
    }
  }
  return results;
}
