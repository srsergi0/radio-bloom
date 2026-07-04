// types-base.d.ts — Non-Zod type declarations
// Matches src/types-base.js

/** Latest supported MCP protocol version */
export declare const LATEST_PROTOCOL_VERSION = "2025-11-25";

/** Default negotiated protocol version */
export declare const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26";

/** All supported MCP protocol versions */
export declare const SUPPORTED_PROTOCOL_VERSIONS: string[];

/** Metadata key for related tasks */
export declare const RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";

/** JSON-RPC version */
export declare const JSONRPC_VERSION = "2.0";

/**
 * Error codes defined by the JSON-RPC specification.
 */
export declare enum ErrorCode {
  ConnectionClosed = -32000,
  RequestTimeout = -32001,
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  UrlElicitationRequired = -32042,
}

/**
 * A response to a request that indicates an error occurred.
 */
export declare class McpError extends Error {
  code: ErrorCode;
  data?: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown);

  static fromError(code: ErrorCode, message: string, data?: unknown): McpError;
}

/**
 * Error thrown when URL elicitation is required.
 */
export declare class UrlElicitationRequiredError extends McpError {
  constructor(elicitations: unknown[], message?: string);
  get elicitations(): unknown[];
}

/**
 * Type guard: checks if value is a JSON-RPC request (has method + id).
 */
export declare const isJSONRPCRequest: (value: unknown) => value is {
  jsonrpc: "2.0";
  method: string;
  id: import("./types.js").RequestId;
  params?: unknown;
};

/**
 * Type guard: checks if value is a JSON-RPC notification (has method, no id).
 */
export declare const isJSONRPCNotification: (value: unknown) => value is {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

/**
 * Type guard: checks if value is a JSON-RPC result response (has id + result).
 */
export declare const isJSONRPCResultResponse: (value: unknown) => value is {
  jsonrpc: "2.0";
  id: import("./types.js").RequestId;
  result: unknown;
};

/**
 * Type guard: checks if value is a JSON-RPC error response (has id + error).
 */
export declare const isJSONRPCErrorResponse: (value: unknown) => value is {
  jsonrpc: "2.0";
  id: import("./types.js").RequestId;
  error: { code: number; message: string; data?: unknown };
};

/**
 * Type guard: checks if value is an initialize request.
 */
export declare const isInitializeRequest: (value: unknown) => value is {
  jsonrpc: "2.0";
  method: "initialize";
  id: import("./types.js").RequestId;
  params?: unknown;
};

/**
 * Type guard: checks if value is an initialized notification.
 */
export declare const isInitializedNotification: (value: unknown) => value is {
  jsonrpc: "2.0";
  method: "notifications/initialized";
  params?: unknown;
};

/**
 * Type guard: checks if value has task-augmented request params.
 */
export declare const isTaskAugmentedRequestParams: (value: unknown) => value is {
  task: unknown;
  [key: string]: unknown;
};

/**
 * Assert that a complete request is for a prompt (ref.type === 'ref/prompt').
 */
export declare function assertCompleteRequestPrompt(request: any): void;

/**
 * Assert that a complete request is for a resource template (ref.type === 'ref/resource').
 */
export declare function assertCompleteRequestResourceTemplate(request: any): void;

/** @deprecated Use isJSONRPCResultResponse instead */
export declare const isJSONRPCResponse: typeof isJSONRPCResultResponse;

/** @deprecated Use isJSONRPCErrorResponse instead */
export declare const isJSONRPCError: typeof isJSONRPCErrorResponse;
