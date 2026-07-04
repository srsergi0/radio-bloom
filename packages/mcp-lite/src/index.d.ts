// @radiobloom/mcp-server — Barrel type declarations
// Re-exports types from the SDK v1.29.0 compiled .d.ts files

export { Server, type ServerOptions } from "./server/index.js";
export { McpServer, ResourceTemplate, type CompleteResourceTemplateCallback, type ToolCallback, type AnyToolHandler, type RegisteredTool, type ResourceMetadata, type ListResourcesCallback, type ReadResourceCallback, type RegisteredResource, type ReadResourceTemplateCallback, type RegisteredResourceTemplate, type PromptCallback, type RegisteredPrompt, type BaseToolCallback } from "./server/mcp.js";
export { StdioServerTransport } from "./server/stdio.js";
export { WebStandardStreamableHTTPServerTransport, type WebStandardStreamableHTTPServerTransportOptions, type HandleRequestOptions, type EventStore } from "./server/webStandardStreamableHttp.js";
export { completable, isCompletable } from "./server/completable.js";
export { InMemoryTransport } from "./inMemory.js";

// Re-export non-Zod types (constants, ErrorCode, McpError, type guards)
export {
  LATEST_PROTOCOL_VERSION,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  RELATED_TASK_META_KEY,
  JSONRPC_VERSION,
  ErrorCode,
  McpError,
  UrlElicitationRequiredError,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  isJSONRPCResponse,
  isJSONRPCError,
  isInitializeRequest,
  isInitializedNotification,
  isTaskAugmentedRequestParams,
  assertCompleteRequestPrompt,
  assertCompleteRequestResourceTemplate,
} from "./types-base.js";

// Re-export key types from shared and types
export { type Transport } from "./shared/transport.js";
export { type JSONRPCMessage, type JSONRPCRequest, type JSONRPCResponse, type JSONRPCError, type JSONRPCNotification, type Implementation, type ServerCapabilities, type ServerNotification, type ServerRequest, type ServerResult, type Request, type Notification, type Result, type CallToolResult, type ToolAnnotations, type Resource, type ListResourcesResult, type GetPromptResult, type ReadResourceResult, type LoggingMessageNotification, type CreateMessageRequest, type CreateMessageResult, type ElicitResult, type ListRootsRequest, type RequestId, type MessageExtraInfo } from "./types.js";
export { type RequestHandlerExtra } from "./shared/protocol.js";

// Aliases for the names used by the publisher
export { WebStandardStreamableHTTPServerTransport as HttpTransport } from "./server/webStandardStreamableHttp.js";
export { StdioServerTransport as StdioTransport } from "./server/stdio.js";
