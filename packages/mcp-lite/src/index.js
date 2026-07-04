// @radiobloom/mcp-server — Barrel exports
// Re-exports from the official @modelcontextprotocol/sdk v1.29.0
// with Express/ajv/jose/cors dependencies stripped.

export * from "./server/index.js";
export { McpServer, ResourceTemplate } from "./server/mcp.js";
export { StdioServerTransport } from "./server/stdio.js";
export { WebStandardStreamableHTTPServerTransport } from "./server/webStandardStreamableHttp.js";
export { completable, isCompletable } from "./server/completable.js";
export * from "./types-base.js";
export { InMemoryTransport } from "./inMemory.js";

// Aliases for the names used by the publisher
export { WebStandardStreamableHTTPServerTransport as HttpTransport } from "./server/webStandardStreamableHttp.js";
export { StdioServerTransport as StdioTransport } from "./server/stdio.js";
