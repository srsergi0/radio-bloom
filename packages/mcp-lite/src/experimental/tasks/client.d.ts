/**
 * Experimental client task features for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */
import { Task, RequestId, Result, JSONRPCRequest, CallToolResult, GetTaskResult } from '../../types.js';
import type { RequestHandlerExtra } from '../../shared/protocol.js';
import type { AnySchema, ZodRawShapeCompat, ShapeOutput } from '../../server/zod-compat.js';
/**
 * Experimental task features for MCP clients.
 * @experimental
 */
export declare class ExperimentalClientTasks {
    private _client;
    constructor(_client: any);
    /**
     * Checks if a tool supports task-based execution.
     */
    isToolTask(toolName: string): boolean;
    /**
     * Checks if a tool requires task-based execution.
     */
    isToolTaskRequired(toolName: string): boolean;
    /**
     * Gets the output validator for a tool, if available.
     */
    getToolOutputValidator(toolName: string): ((output: unknown) => any) | undefined;
    /**
     * Sends a request and returns an AsyncGenerator that yields response messages.
     */
    requestStream(request: JSONRPCRequest, resultSchema: AnySchema, options?: any): AsyncGenerator<any, void, unknown>;
    /**
     * Gets a task by ID.
     */
    getTask(params: { taskId: string }, options?: any): Promise<Task>;
    /**
     * Gets the result of a completed task.
     */
    getTaskResult(params: { taskId: string }, resultSchema: AnySchema, options?: any): Promise<any>;
    /**
     * Lists tasks with optional pagination.
     */
    listTasks(params?: { cursor?: string }, options?: any): Promise<{ tasks: Task[]; nextCursor?: string }>;
    /**
     * Cancels a running task.
     */
    cancelTask(params: { taskId: string }, options?: any): Promise<void>;
    /**
     * Calls a tool with task-aware execution.
     */
    callToolStream(request: JSONRPCRequest, resultSchema: AnySchema, options?: any): Promise<any> | AsyncGenerator<any, void, unknown>;
}
