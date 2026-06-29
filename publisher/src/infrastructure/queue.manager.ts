import { type Processor, Queue, type QueueOptions, Worker, type WorkerOptions } from "bullmq";

export class QueueManager {
  private readonly redisConnection = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
  };

  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();

  /**
   * Get or create a BullMQ Queue
   */
  public getQueue(name: string, options?: Partial<QueueOptions>): Queue {
    if (this.queues.has(name)) {
      return this.queues.get(name)!;
    }

    const queue = new Queue(name, {
      connection: this.redisConnection,
      defaultJobOptions: {
        removeOnComplete: {
          count: 100, // Keep last 100 completed jobs for dashboard visibility
          age: 24 * 3600, // Max age 24 hours
        },
        removeOnFail: {
          count: 1000, // Keep last 1000 failed jobs for troubleshooting
          age: 7 * 24 * 3600, // Max age 7 days
        },
      },
      ...options,
    });

    queue.on("error", (err) => {
      console.error(`[QueueManager] Queue '${name}' connection error:`, err.message);
    });

    this.queues.set(name, queue);
    return queue;
  }

  /**
   * Register a worker for a queue
   */
  public registerWorker(
    queueName: string,
    processor: Processor,
    options?: Partial<WorkerOptions>
  ): Worker {
    if (this.workers.has(queueName)) {
      throw new Error(`Worker for queue '${queueName}' is already registered`);
    }

    const worker = new Worker(queueName, processor, {
      connection: this.redisConnection,
      ...options,
    });

    worker.on("error", (err) => {
      console.error(`[QueueManager] Worker for '${queueName}' connection error:`, err.message);
    });

    this.workers.set(queueName, worker);
    return worker;
  }

  /**
   * Close all queues and workers
   */
  public async close(): Promise<void> {
    for (const worker of this.workers.values()) {
      await worker.close().catch(() => {});
    }
    for (const queue of this.queues.values()) {
      await queue.close().catch(() => {});
    }
    this.workers.clear();
    this.queues.clear();
  }
}
