# mcp-lite — Features & Known Limitations

Ultra-lightweight MCP server extracted from the official `@modelcontextprotocol/sdk` v1.29.0. Pure JavaScript, no Express/ajv/jose, minimal dependencies.

## Features

### Protocol Compliance (MCP Spec 2025-11-25)

- **Lifecycle**: `initialize`, `notifications/initialized`, `ping`
- **Tools**: `tools/list` (with cursor pagination), `tools/call`, `notifications/tools/list_changed`
- **Resources**: `resources/list`, `resources/templates/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `notifications/resources/list_changed`, `notifications/resources/updated`
- **Prompts**: `prompts/list` (with cursor pagination), `prompts/get`, `notifications/prompts/list_changed`
- **Completion**: `completion/complete` (auto-generates resource/template/prompt completions)
- **Logging**: `logging/setLevel`, `notifications/message` with severity filtering
- **Progress**: `notifications/progress` with token tracking
- **Cancellation**: `notifications/cancelled` with abort controller support
- **Error handling**: `McpError` class with typed error codes (`ToolNotFound`, `ResourceNotFound`, `PromptNotFound`, `ParseError`, etc.)

### Transports

| Transport | Protocol | Notes |
|---|---|---|
| `StdioServerTransport` | stdio | Standard MCP stdio transport |
| `WebStandardStreamableHTTPServerTransport` | HTTP (Hono) | Streamable HTTP with SSE streaming or JSON responses |

#### Streamable HTTP Transport

- **POST `/mcp`**: JSON-RPC requests (accepts `application/json` or `application/jsonl`)
- **GET `/mcp`**: SSE stream for server-initiated messages (per session)
- **DELETE `/mcp`**: Session termination
- **Session management**: Automatic timeout, LRU eviction, configurable `maxSessions`
- **Response modes**: SSE streaming (default) or `enableJsonResponse: true` for single JSON response
- **Origin validation**: CORS support with configurable allowed origins

### Server Classes

#### `Server` (low-level)

- Direct protocol handling with explicit capability registration
- Manual request/notification handler registration via `setRequestHandler(MethodSchema, handler)`
- Support for both Zod schemas and string method names for handler registration

#### `McpServer` (high-level)

- Declarative registration: `.tool()`, `.resource()`, `.resourceTemplate()`, `.prompt()`
- Automatic capability negotiation from registered handlers
- Zod schema validation for tool parameters
- Tool annotations support (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
- Resource subscription support
- Notification broadcasting: `sendToolListChanged()`, `sendResourceListChanged()`, etc.

### Experimental: Task-Augmented Execution

Located in `src/experimental/tasks/`:

- **Task-augmented requests**: `CreateTaskResultSchema` for tracking long-running operations
- **Task cancellation**: Server-side task cancellation support
- **Progress streaming**: `TaskProgressToken` for real-time progress updates
- **`createMessageStream()`**: Async generator for streaming task results
- **`elicitInputStream()`**: Async generator for interactive input streams
- **`InMemoryTaskStore`**: In-memory task storage with automatic TTL cleanup
- **`InMemoryTaskMessageQueue`**: FIFO message queue per task
- **`ExperimentalClientTasks`**: Client-side task support (callToolStream, getTask, listTasks, cancelTask)
- **`ExperimentalServerTasks`**: Server-side task support (requestStream, createMessageStream, elicitInputStream)
- **Note**: These are experimental features, not yet part of the official MCP spec

### Validation

- **`PassthroughJsonSchemaValidator`**: Lightweight JSON Schema validator that returns schemas as-is (no validation). Replaces the heavy `ajv` dependency.
- **`McpJsonSchemaToZodConverter`**: Converts JSON Schema to Zod schemas for runtime validation
- **`parseWithCompat()`**: Zod v3/v4 compatible parsing with automatic schema detection

### Zod Compatibility

- **Dual Zod support**: Both `zod` (v3) and `zod/v4` / `zod/v4-mini` are supported
- **Automatic detection**: `parseWithCompat()` auto-detects Zod version via `_def` structure
- **Schema conversion**: `zod-to-json-schema` for JSON Schema generation

## Performance Optimizations (3 Phases Applied)

### Phase 1: Module Load Optimization (-31%)

- Inlined `isTerminal()` in `protocol.js` (eliminates experimental import chain)
- Lazy-loaded task helpers in `server/index.js` via `await import()`
- Lazy-loaded `zod/v4-mini` in `zod-json-schema-compat.js`
- Removed `ZodOptional` import (duck-typing instead)

### Phase 2: Per-Instance Optimization

- 7 Protocol Maps/Set lazy-init via getters (`_getRequestResolvers()`, etc.)
- 4 registries converted from Object to Map (`_registeredTools`, `_registeredResources`, etc.)

### Phase 3: Lazy Zod Compilation (-50% total)

- **`types-base.js`**: Non-Zod exports (~100 lines): ErrorCode, McpError, type guards, version constants. Loads in 0.1ms.
- **`types.js`**: Zod schemas, only loaded on first message arrival (~90ms deferred)
- **String method names**: `setRequestHandler('tools/call', handler)` instead of schema objects
- **Simplified type guards**: Property-checks instead of `Zod.safeParse()` for dispatch

## Known Limitations & Potential Issues

### Missing Features (vs Official SDK)

1. **OAuth/Middleware**: No `auth()` middleware, no OAuth support. Use a separate auth layer (e.g., Hono middleware).
2. **Express transport**: No `StreamableHTTPServerTransport` for Express. Use the Hono-based transport.
3. **`maxSessions` / `sessionTimeoutMs`**: These options are NOT available on the HTTP transport (they were removed as they're not in the official SDK's `WebStandardStreamableHTTPServerTransport`).
4. **`Server` constructor**: Does NOT accept `capabilities` option. Capabilities are registered via `setRequestHandler()` calls.

### Type Declarations

- **Complete type coverage**: All `.js` files have matching `.d.ts` declarations. The barrel `index.d.ts` re-exports all public types including `types-base.js` (ErrorCode, McpError, type guards).
- **`auth/types.d.ts`**: Stub for `AuthInfo` type (OAuth was stripped). Custom auth middleware can use this type.
- **`validation/ajv-provider.d.ts`**: Direct type declarations for `PassthroughJsonSchemaValidator`.
- **Cross-version Zod compatibility**: `AnySchema = any` ensures schemas from any Zod version (v3, v4, or different installations) work. `SchemaOutput<S>` returns `any` for unknown schemas. External consumers get full type inference when using the same Zod installation as the package.
- **Experimental tasks types**: `experimental/tasks/types.d.ts` exists but may not cover all edge cases.

### Zod Compatibility

- **`zod-compat.js`**: The `isZodType()` function works by checking `_def.typeName` or `_zod.def.type`. Custom Zod types or Zod types from non-standard builds may not be detected correctly.
- **Zod v4 differences**: `zod/v4` and `zod/v4-mini` have different class names (`ZodObject` vs `ZodMiniObject`). The compatibility layer handles this, but edge cases may exist.

### Validation

- **`PassthroughJsonSchemaValidator`**: Does NOT actually validate against JSON schemas. It returns the schema as-is. This is intentional (lightweight replacement for ajv), but means JSON Schema validation is effectively disabled. If you need JSON Schema validation, you'll need to add a custom validator.
- **`McpJsonSchemaToZodConverter`**: May not handle all JSON Schema constructs (e.g., `$ref`, `allOf`, `oneOf` with complex schemas).

### Experimental Tasks

- **Not stable**: The `experimental/tasks/` module is not part of the official MCP spec. APIs may change.
- **InMemoryTaskStore/InMemoryTaskMessageQueue**: In-memory implementations with TTL cleanup. For production, consider persistent storage.
- **`ExperimentalClientTasks`**: Client-side task support. Requires the client to have a `_protocol` property and `_toolMetadata` Map.
- **`createMessageStream` / `elicitInputStream`**: These are async generators that yield results. They may not work correctly with all MCP clients that expect standard request/response patterns.
- **Task progress tracking**: Requires the client to support `TaskProgressToken`. Not all clients implement this.

### HTTP Transport

- **SSE streaming**: The `GET /mcp` endpoint returns an SSE stream. Some proxies/load balancers may buffer SSE responses, causing delays. Configure proxies to pass through SSE properly.
- **Session cleanup**: Sessions are cleaned up via timeout, but if the server crashes, orphaned sessions may remain in memory until restart.
- **Content-Type handling**: Supports `application/json` and `application/jsonl`. Other content types (e.g., `application/xml`) are rejected.

### Module Loading

- **Lazy Zod loading**: Zod schemas are loaded on first use, not at import time. This means the first `tools/call` message may have ~90ms additional latency while Zod loads. Subsequent messages are unaffected.
- **`types-base.js` vs `types.js`**: The barrel `index.js` exports from `types-base.js` (no Zod). If you need Zod schemas directly, import from `types.js`.

### Platform

- **Bun recommended**: While the code is standard JavaScript, it's optimized for Bun. Node.js may work but is not tested.
- **No Windows-specific testing**: Tested on Linux/Docker. Windows may have path handling differences.

## File Structure

```
src/
├── index.js                  # Barrel exports (from types-base.js)
├── index.d.ts                # Barrel type declarations
├── types-base.js             # Non-Zod exports (0ms load)
├── types-base.d.ts           # Non-Zod type declarations
├── types.js                  # Zod schemas (lazy-loaded, ~90ms)
├── inMemory.js               # InMemoryTransport
├── server/
│   ├── mcp.js                # McpServer (high-level)
│   ├── index.js              # Server (low-level)
│   ├── stdio.js              # StdioServerTransport
│   ├── webStandardStreamableHttp.js  # HTTP transport
│   ├── completable.js        # Completable helper
│   ├── zod-compat.js         # Zod v3/v4 compatibility
│   ├── zod-json-schema-compat.js  # Zod → JSON Schema
│   └── auth/
│       └── types.d.ts        # AuthInfo type stub
├── shared/
│   ├── protocol.js           # Protocol base class
│   ├── transport.js          # Transport interface
│   ├── stdio.js              # ReadBuffer + deserializeMessage
│   ├── uriTemplate.js        # URI template parsing
│   ├── toolNameValidation.js # Tool name validation
│   ├── metadataUtils.js      # Metadata helpers
│   └── responseMessage.js    # Response message helpers
├── validation/
│   ├── ajv-provider.js       # PassthroughJsonSchemaValidator
│   ├── ajv-provider.d.ts     # PassthroughJsonSchemaValidator types
│   ├── types.d.ts            # Validation interface types
│   └── index.js              # Validation barrel
└── experimental/
    ├── tasks/
    │   ├── helpers.js        # Task helper functions
    │   ├── interfaces.js     # Task interfaces
    │   ├── client.js         # Client task support (experimental)
    │   ├── mcp-server.js     # McpServer task augmentation
    │   ├── server.js         # Server task augmentation
    │   ├── types.js          # Task type definitions
    │   └── stores/
    │       └── in-memory.js  # InMemoryTaskStore + InMemoryTaskMessageQueue
```

## Usage with Publisher

The publisher uses this package via `mcp.service.ts`:

```typescript
import { McpServer, StdioServerTransport, WebStandardStreamableHTTPServerTransport } from "mcp-lite";

const mcpServer = new McpServer({
  name: "radio-bloom",
  version: "1.0.0",
});

// Register tools with Zod schemas
mcpServer.tool("radio_status", "Get radio status", {}, async () => {
  return { content: [{ type: "text", text: JSON.stringify(status) }] };
});

// Connect via stdio or HTTP
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
```
