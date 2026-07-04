// types-base.js — Non-Zod exports (constants, ErrorCode, McpError, type guards)
// NO Zod dependency. This file loads instantly.

export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';
export const JSONRPC_VERSION = '2.0';

/**
 * Error codes defined by the JSON-RPC specification.
 */
export var ErrorCode;
(function (ErrorCode) {
    ErrorCode[ErrorCode["ConnectionClosed"] = -32000] = "ConnectionClosed";
    ErrorCode[ErrorCode["RequestTimeout"] = -32001] = "RequestTimeout";
    ErrorCode[ErrorCode["ParseError"] = -32700] = "ParseError";
    ErrorCode[ErrorCode["InvalidRequest"] = -32600] = "InvalidRequest";
    ErrorCode[ErrorCode["MethodNotFound"] = -32601] = "MethodNotFound";
    ErrorCode[ErrorCode["InvalidParams"] = -32602] = "InvalidParams";
    ErrorCode[ErrorCode["InternalError"] = -32603] = "InternalError";
    ErrorCode[ErrorCode["UrlElicitationRequired"] = -32042] = "UrlElicitationRequired";
})(ErrorCode || (ErrorCode = {}));

/**
 * A response to a request that indicates an error occurred.
 */
export class McpError extends Error {
    constructor(code, message, data) {
        super(`MCP error ${code}: ${message}`);
        this.code = code;
        this.data = data;
        this.name = 'McpError';
    }
    static fromError(code, message, data) {
        if (code === ErrorCode.UrlElicitationRequired && data) {
            const errorData = data;
            if (errorData.elicitations) {
                return new UrlElicitationRequiredError(errorData.elicitations, message);
            }
        }
        return new McpError(code, message, data);
    }
}

export class UrlElicitationRequiredError extends McpError {
    constructor(elicitations, message = `URL elicitation${elicitations.length > 1 ? 's' : ''} required`) {
        super(ErrorCode.UrlElicitationRequired, message, {
            elicitations: elicitations
        });
    }
    get elicitations() {
        return this.data?.elicitations ?? [];
    }
}

// Simple property-check type guards (no Zod needed)
export const isJSONRPCRequest = (value) =>
    typeof value === 'object' && value !== null
    && value.jsonrpc === '2.0'
    && typeof value.method === 'string'
    && 'id' in value;

export const isJSONRPCNotification = (value) =>
    typeof value === 'object' && value !== null
    && value.jsonrpc === '2.0'
    && typeof value.method === 'string'
    && !('id' in value);

export const isJSONRPCResultResponse = (value) =>
    typeof value === 'object' && value !== null
    && value.jsonrpc === '2.0'
    && 'id' in value
    && 'result' in value;

export const isJSONRPCErrorResponse = (value) =>
    typeof value === 'object' && value !== null
    && value.jsonrpc === '2.0'
    && 'id' in value
    && 'error' in value;

export const isInitializeRequest = (value) =>
    typeof value === 'object' && value !== null
    && value.method === 'initialize';

export const isInitializedNotification = (value) =>
    typeof value === 'object' && value !== null
    && value.method === 'notifications/initialized';

export const isTaskAugmentedRequestParams = (value) =>
    typeof value === 'object' && value !== null
    && 'task' in value;

// Assert functions (no Zod needed)
export function assertCompleteRequestPrompt(request) {
    if (request.params.ref.type !== 'ref/prompt') {
        throw new TypeError(`Expected CompleteRequestPrompt, but got ${request.params.ref.type}`);
    }
    void request;
}

export function assertCompleteRequestResourceTemplate(request) {
    if (request.params.ref.type !== 'ref/resource') {
        throw new TypeError(`Expected CompleteRequestResourceTemplate, but got ${request.params.ref.type}`);
    }
    void request;
}

// Deprecated aliases
export const isJSONRPCResponse = isJSONRPCResultResponse;
export const isJSONRPCError = isJSONRPCErrorResponse;
