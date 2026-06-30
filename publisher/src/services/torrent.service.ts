/**
 * Torrent Service
 * Handles torrent search and queue management via Redis.
 */
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/0";

export class TorrentService {
  private redis: Redis;
  private queueName = "music-downloads";

  constructor() {
    this.redis = new Redis(REDIS_URL);
  }

  /**
   * Search torrents on The Pirate Bay
   */
  async search(query: string, limit = 5): Promise<TorrentResult[]> {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=1000`;
    const headers = { "User-Agent": "Mozilla/5.0" };

    try {
      const response = await fetch(url, { headers });
      const data = (await response.json()) as any[];

      return data
        .filter((item: any) => item.id !== "0")
        .slice(0, limit)
        .map((item: any) => ({
          name: item.name || "N/A",
          seeds: parseInt(item.seeders || "0"),
          leechers: parseInt(item.leechers || "0"),
          size: parseInt(item.size || "0") / (1024 * 1024), // Convert to MB
          infoHash: item.info_hash || "",
          magnet: `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}`,
        }));
    } catch (error) {
      console.error("[TorrentService] Search error:", error);
      return [];
    }
  }

  /**
   * Add a download to the queue
   */
  async queueDownload(magnet: string, name: string): Promise<QueueJob> {
    const jobId = crypto.randomUUID();
    const job: QueueJob = {
      id: jobId,
      magnet,
      name,
      status: "queued",
      createdAt: new Date().toISOString(),
      progress: 0,
    };

    await this.redis.hset(this.queueName, jobId, JSON.stringify(job));
    await this.redis.lpush(`${this.queueName}:pending`, jobId);

    return job;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<QueueJob | null> {
    const data = await this.redis.hget(this.queueName, jobId);
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * Update job status
   */
  async updateJobStatus(
    jobId: string,
    status: QueueJob["status"],
    progress = 0,
    files: string[] = []
  ): Promise<void> {
    const job = await this.getJobStatus(jobId);
    if (!job) return;

    job.status = status;
    job.progress = progress;
    job.files = files;
    if (status === "completed" || status === "failed") {
      job.completedAt = new Date().toISOString();
    }

    await this.redis.hset(this.queueName, jobId, JSON.stringify(job));
  }

  /**
   * Get next job from queue
   */
  async getNextJob(): Promise<QueueJob | null> {
    const jobId = await this.redis.rpop(`${this.queueName}:pending`);
    if (!jobId) return null;

    const job = await this.getJobStatus(jobId);
    if (!job) return null;

    job.status = "downloading";
    job.startedAt = new Date().toISOString();
    await this.redis.hset(this.queueName, jobId, JSON.stringify(job));

    return job;
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<QueueStats> {
    const pending = await this.redis.llen(`${this.queueName}:pending`);
    const allJobs = await this.redis.hgetall(this.queueName);

    let downloading = 0;
    let completed = 0;
    let failed = 0;

    for (const data of Object.values(allJobs)) {
      const job: QueueJob = JSON.parse(data);
      if (job.status === "downloading") downloading++;
      else if (job.status === "completed") completed++;
      else if (job.status === "failed") failed++;
    }

    return { pending, downloading, completed, failed };
  }

  /**
   * List recent jobs
   */
  async listJobs(limit = 10): Promise<QueueJob[]> {
    const allJobs = await this.redis.hgetall(this.queueName);
    const jobs = Object.values(allJobs)
      .map((data) => JSON.parse(data) as QueueJob)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    return jobs;
  }

  /**
   * Cancel a queued job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const job = await this.getJobStatus(jobId);
    if (!job || job.status !== "queued") return false;

    await this.redis.lrem(`${this.queueName}:pending`, 0, jobId);
    await this.redis.hdel(this.queueName, jobId);
    return true;
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
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

export interface QueueJob {
  id: string;
  magnet: string;
  name: string;
  status: "queued" | "downloading" | "completed" | "failed";
  progress: number;
  files?: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface QueueStats {
  pending: number;
  downloading: number;
  completed: number;
  failed: number;
}
