#!/usr/bin/env bun
/**
 * Download Worker
 * Processes torrent downloads from the queue.
 * Run with: bun src/worker.ts
 */

import Redis from "ioredis";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/0";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "./downloads";
const QUEUE_NAME = "music-downloads";

const redis = new Redis(REDIS_URL);

interface QueueJob {
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

async function updateJob(job: QueueJob): Promise<void> {
  await redis.hset(QUEUE_NAME, job.id, JSON.stringify(job));
}

async function processJob(job: QueueJob): Promise<void> {
  console.log(`[Worker] Processing: ${job.name}`);

  job.status = "downloading";
  job.startedAt = new Date().toISOString();
  await updateJob(job);

  const safeName = job.name.replace(/[^a-zA-Z0-9 -_]/g, "").slice(0, 50);
  const downloadPath = `${DOWNLOAD_DIR}/${safeName}`;
  os.mkdirSync(downloadPath, { recursive: true });

  const cmd = [
    "aria2c",
    `--dir=${downloadPath}`,
    "--seed-time=0",
    "--bt-stop-time=600",
    "--max-connection-per-server=16",
    "--split=16",
    "--continue=true",
    "--daemon=false",
    "--summary-interval=5",
    "--console-log-level=warn",
    `"${job.magnet}"`,
  ].join(" ");

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 900000 }); // 15 min

    // List downloaded files
    const files = fs.readdirSync(downloadPath).filter((f) =>
      [".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus"].some((ext) => f.endsWith(ext))
    );

    job.status = "completed";
    job.files = files;
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    await updateJob(job);

    console.log(`[Worker] Completed: ${job.name} (${files.length} files)`);
  } catch (error: any) {
    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    await updateJob(job);

    console.error(`[Worker] Failed: ${job.name} - ${error.message}`);
  }
}

async function pollQueue(): Promise<void> {
  while (true) {
    try {
      const jobId = await redis.rpop(`${QUEUE_NAME}:pending`);
      if (jobId) {
        const data = await redis.hget(QUEUE_NAME, jobId);
        if (data) {
          const job: QueueJob = JSON.parse(data);
          await processJob(job);
        }
      } else {
        // No jobs, wait before checking again
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error) {
      console.error("[Worker] Error:", error);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}

import fs from "fs";
import os from "os";

// Ensure download directory exists
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

console.log("[Worker] Starting download worker...");
console.log(`[Worker] Download dir: ${DOWNLOAD_DIR}`);
console.log(`[Worker] Redis: ${REDIS_URL}`);

pollQueue();
