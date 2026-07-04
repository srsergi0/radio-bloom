/**
 * In-memory task store and message queue for MCP experimental tasks.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */
import { Task, RequestId, Result, Request } from '../../types.js';
import type { TaskStore, TaskMessageQueue, QueuedMessage, CreateTaskOptions } from '../interfaces.js';
/**
 * In-memory implementation of TaskStore.
 * Stores tasks and results in Maps with automatic TTL cleanup.
 *
 * @experimental
 */
export declare class InMemoryTaskStore implements TaskStore {
    private _tasks;
    private _timers;
    createTask(taskParams: CreateTaskOptions, requestId: RequestId, request: Request, sessionId?: string): Promise<Task>;
    getTask(taskId: string, sessionId?: string): Promise<Task | null>;
    storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result, sessionId?: string): Promise<void>;
    getTaskResult(taskId: string, sessionId?: string): Promise<Result>;
    updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string, sessionId?: string): Promise<void>;
    listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }>;
    close(): Promise<void>;
    private _key;
}
/**
 * In-memory implementation of TaskMessageQueue.
 * Stores messages in FIFO queues per task.
 *
 * @experimental
 */
export declare class InMemoryTaskMessageQueue implements TaskMessageQueue {
    private _queues;
    enqueue(taskId: string, message: QueuedMessage, sessionId?: string, maxSize?: number): Promise<void>;
    dequeue(taskId: string, sessionId?: string): Promise<QueuedMessage | undefined>;
    dequeueAll(taskId: string, sessionId?: string): Promise<QueuedMessage[]>;
    close(): Promise<void>;
    private _key;
}
