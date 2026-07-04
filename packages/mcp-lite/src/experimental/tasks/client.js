/**
 * Experimental client task features for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */
import { isTerminal } from './interfaces.js';

/**
 * Experimental task features for MCP clients.
 *
 * Provides task-aware callTool, getTask, getTaskResult, listTasks, cancelTask,
 * and requestStream for streaming task-augmented requests.
 *
 * @experimental
 */
export class ExperimentalClientTasks {
    constructor(_client) {
        this._client = _client;
    }

    /**
     * Checks if a tool supports task-based execution.
     */
    isToolTask(toolName) {
        const tool = this._client._toolMetadata?.get(toolName);
        return tool?.execution?.taskSupport === 'required' || tool?.execution?.taskSupport === 'optional';
    }

    /**
     * Checks if a tool requires task-based execution.
     */
    isToolTaskRequired(toolName) {
        const tool = this._client._toolMetadata?.get(toolName);
        return tool?.execution?.taskSupport === 'required';
    }

    /**
     * Gets the output validator for a tool, if available.
     */
    getToolOutputValidator(toolName) {
        const tool = this._client._toolMetadata?.get(toolName);
        return tool?.outputValidator;
    }

    /**
     * Sends a request and returns an AsyncGenerator that yields response messages.
     * The generator is guaranteed to end with either a 'result' or 'error' message.
     *
     * @experimental
     */
    requestStream(request, resultSchema, options) {
        return this._client._protocol.requestStream(request, resultSchema, options);
    }

    /**
     * Gets a task by ID.
     *
     * @experimental
     */
    async getTask(params, options) {
        return this._client._protocol.getTask(params, options);
    }

    /**
     * Gets the result of a completed task.
     *
     * @experimental
     */
    async getTaskResult(params, resultSchema, options) {
        return this._client._protocol.getTaskResult(params, resultSchema, options);
    }

    /**
     * Lists tasks with optional pagination.
     *
     * @experimental
     */
    async listTasks(params, options) {
        return this._client._protocol.listTasks(params, options);
    }

    /**
     * Cancels a running task.
     *
     * @experimental
     */
    async cancelTask(params, options) {
        return this._client._protocol.cancelTask(params, options);
    }

    /**
     * Calls a tool with task-aware execution.
     * If the tool supports tasks, creates a task and streams results.
     * Otherwise, falls back to standard callTool.
     *
     * @experimental
     */
    async callToolStream(request, resultSchema, options) {
        const toolName = request.params?.name;
        if (toolName && this.isToolTask(toolName)) {
            return this._client._protocol.requestStream(request, resultSchema, options);
        }
        return this._client._protocol.request(request, resultSchema, options);
    }
}
