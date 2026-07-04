/**
 * In-memory task store and message queue for MCP experimental tasks.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */
import { isTerminal } from '../interfaces.js';

/**
 * Generates a unique task ID.
 */
function generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * In-memory implementation of TaskStore.
 * Stores tasks and results in Maps with automatic TTL cleanup.
 *
 * @experimental
 */
export class InMemoryTaskStore {
    constructor() {
        /** @type {Map<string, {task: import('../../types.js').Task, result: import('../../types.js').Result | null}>} */
        this._tasks = new Map();
        /** @type {Map<string, ReturnType<typeof setTimeout>>} */
        this._timers = new Map();
    }

    /**
     * Creates a new task with the given creation parameters and original request.
     */
    async createTask(taskParams, requestId, request, sessionId) {
        const taskId = generateTaskId();
        const now = Date.now();
        const ttl = taskParams.ttl ?? null;

        const task = {
            taskId,
            status: 'pending',
            createdAt: now,
            ...(ttl !== null && { ttl }),
            ...(taskParams.pollInterval !== undefined && { pollInterval: taskParams.pollInterval }),
            ...(requestId !== undefined && { requestId }),
        };

        this._tasks.set(this._key(taskId, sessionId), { task, result: null });

        // Schedule TTL cleanup
        if (ttl !== null && ttl > 0) {
            const timer = setTimeout(() => {
                this._tasks.delete(this._key(taskId, sessionId));
                this._timers.delete(this._key(taskId, sessionId));
            }, ttl);
            this._timers.set(this._key(taskId, sessionId), timer);
        }

        return task;
    }

    /**
     * Gets the current status of a task.
     */
    async getTask(taskId, sessionId) {
        const entry = this._tasks.get(this._key(taskId, sessionId));
        return entry?.task ?? null;
    }

    /**
     * Stores the result of a task and sets its final status.
     */
    async storeTaskResult(taskId, status, result, sessionId) {
        const entry = this._tasks.get(this._key(taskId, sessionId));
        if (entry) {
            entry.task.status = status;
            entry.result = result;

            // Clear TTL timer on completion
            if (isTerminal(status)) {
                const timer = this._timers.get(this._key(taskId, sessionId));
                if (timer) {
                    clearTimeout(timer);
                    this._timers.delete(this._key(taskId, sessionId));
                }

                // Schedule cleanup after result is stored
                const ttl = entry.task.ttl;
                if (ttl !== null && ttl !== undefined && ttl > 0) {
                    const cleanupTimer = setTimeout(() => {
                        this._tasks.delete(this._key(taskId, sessionId));
                    }, ttl);
                    this._timers.set(this._key(taskId, sessionId), cleanupTimer);
                }
            }
        }
    }

    /**
     * Retrieves the stored result of a task.
     */
    async getTaskResult(taskId, sessionId) {
        const entry = this._tasks.get(this._key(taskId, sessionId));
        return entry?.result ?? {};
    }

    /**
     * Updates a task's status.
     */
    async updateTaskStatus(taskId, status, statusMessage, sessionId) {
        const entry = this._tasks.get(this._key(taskId, sessionId));
        if (entry) {
            entry.task.status = status;
            if (statusMessage) {
                entry.task.statusMessage = statusMessage;
            }
        }
    }

    /**
     * Lists tasks with optional pagination.
     */
    async listTasks(cursor, sessionId) {
        const tasks = [];
        for (const [, entry] of this._tasks) {
            tasks.push(entry.task);
        }
        return { tasks, nextCursor: undefined };
    }

    /**
     * Cleans up all tasks and timers.
     */
    async close() {
        for (const timer of this._timers.values()) {
            clearTimeout(timer);
        }
        this._timers.clear();
        this._tasks.clear();
    }

    /**
     * Generates a storage key combining taskId and sessionId.
     */
    _key(taskId, sessionId) {
        return sessionId ? `${taskId}:${sessionId}` : taskId;
    }
}

/**
 * In-memory implementation of TaskMessageQueue.
 * Stores messages in FIFO queues per task.
 *
 * @experimental
 */
export class InMemoryTaskMessageQueue {
    constructor() {
        /** @type {Map<string, import('../interfaces.js').QueuedMessage[]>} */
        this._queues = new Map();
    }

    /**
     * Adds a message to the end of the queue for a specific task.
     */
    async enqueue(taskId, message, sessionId, maxSize) {
        const key = this._key(taskId, sessionId);
        let queue = this._queues.get(key);
        if (!queue) {
            queue = [];
            this._queues.set(key, queue);
        }

        if (maxSize !== undefined && queue.length >= maxSize) {
            throw new Error(`Message queue for task ${taskId} is full (max size: ${maxSize})`);
        }

        queue.push({ ...message, timestamp: Date.now() });
    }

    /**
     * Removes and returns the first message from the queue for a specific task.
     */
    async dequeue(taskId, sessionId) {
        const key = this._key(taskId, sessionId);
        const queue = this._queues.get(key);
        if (!queue || queue.length === 0) {
            return undefined;
        }
        return queue.shift();
    }

    /**
     * Removes and returns all messages from the queue for a specific task.
     */
    async dequeueAll(taskId, sessionId) {
        const key = this._key(taskId, sessionId);
        const queue = this._queues.get(key);
        if (!queue) {
            return [];
        }
        const messages = [...queue];
        queue.length = 0;
        return messages;
    }

    /**
     * Cleans up all queues.
     */
    async close() {
        this._queues.clear();
    }

    /**
     * Generates a storage key combining taskId and sessionId.
     */
    _key(taskId, sessionId) {
        return sessionId ? `${taskId}:${sessionId}` : taskId;
    }
}
