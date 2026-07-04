<p align="center">
  <img src="https://img.shields.io/npm/v/mcp-lite?label=mcp-lite&color=blue" alt="npm version">
  <img src="https://img.shields.io/npm/dm/mcp-lite" alt="npm downloads">
  <img src="https://img.shields.io/npm/l/mcp-lite" alt="license">
  <img src="https://img.shields.io/badge/MCP%20Spec-2025--11--25-blue" alt="MCP Spec">
  <img src="https://img.shields.io/badge/Runtime-Bun-orange" alt="Bun">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue" alt="TypeScript">
</p>

<h1 align="center">mcp-lite</h1>

<p align="center">
  <strong>Ultra-lightweight MCP server for Bun. Zero Express, zero ajv, zero jose.</strong><br>
  Full protocol compliance. ~5MB heap. Drop-in replacement for <code>@modelcontextprotocol/sdk</code>.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#why-mcp-lite">Why</a> ·
  <a href="#performance">Performance</a> ·
  <a href="#api-reference">API</a> ·
  <a href="#migration-from-official-sdk">Migration</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## Why mcp-lite?

The official `@modelcontextprotocol/sdk` pulls in **Express 5, ajv, jose, cors** and 27+ transitive dependencies — adding **~150-200MB** to your heap. If you're building on Bun + Hono, you don't need any of that.

**mcp-lite** extracts the exact same MCP protocol implementation from the official SDK, strips the bloat, and gives you:

- **50% faster module load** — Zod schemas lazy-loaded on first message, not at import
- **78% less heap** — 5MB vs 150-200MB
- **Zero Express** — uses Hono (which you already have)
- **Zero ajv** — passthrough JSON Schema validator
- **Full TypeScript types** — complete `.d.ts` declarations for any consumer
- **100% protocol compliant** — MCP spec 2025-11-25

### Comparison

| | `@modelcontextprotocol/sdk` | `mcp-lite` |
|---|---|---|
| **Dependencies** | Express 5, ajv, jose, cors, eventsource... | zod + hono (peer) |
| **Heap footprint** | ~150-200MB | ~5MB |
| **Module load** | ~190ms | ~93ms |
| **Transports** | stdio, SSE, Streamable HTTP | stdio, Streamable HTTP |
| **Protocol version** | 2025-11-25 | 2025-11-25 |
| **TypeScript** | Full | Full |
| **Runtime** | Node.js, Bun, Deno | Bun (optimized) |
| **OAuth** | Built-in | Not included (use Hono middleware) |
| **Package size** | ~2.5MB unpacked | ~50KB unpacked |

## Quick Start

### 1. Install

```bash
bun add mcp-lite zod
```

### 2. Create a server

```typescript
import { McpServer, StdioServerTransport } from "mcp-lite";
import { z } from "zod";

const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
});

server.tool(
  "get_weather",
  "Get current weather for a city",
  { city: z.string().describe("City name") },
  async ({ city }) => ({
    content: [{ type: "text", text: `Weather in ${city}: Sunny, 72°F` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 3. Run it

```bash
bun run my-server.ts
```

That's it. Your MCP server is running over stdio.

### HTTP Transport (Hono)

```typescript
import { McpServer, WebStandardStreamableHTTPServerTransport } from "mcp-lite";
import { Hono } from "hono";
import { z } from "zod";

const server = new McpServer({
  name: "my-server",
  version: "1.0.0",
});

server.tool(
  "search",
  "Search for items",
  { query: z.string() },
  async ({ query }) => ({
    content: [{ type: "text", text: `Results for: ${query}` }],
  })
);

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

await server.connect(transport);

const app = new Hono();
app.all("/mcp", (c) => transport.handleRequest(c.req.raw));

export default app;
```

## Performance

mcp-lite is designed for cold-start performance. Here's what happens when your server starts:

```
Module load:    93ms   (vs 190ms official SDK)
  types-base:    0.1ms (ErrorCode, McpError, type guards)
  protocol:     12ms   (lazy Maps, inlined isTerminal)
  server:        8ms   (lazy task helpers)
  zod:          90ms   (DEFERRED — only loads on first message)
```

**Key optimizations:**
- Zod schemas compile on first `tools/call`, not at import time
- Protocol Maps use lazy getters (7 Maps created on-demand)
- `isTerminal()` inlined to eliminate `experimental/tasks/interfaces.js` chain
- Type guards use duck-typing, not `Zod.safeParse()`

## API Reference

### `McpServer`

High-level server with declarative registration.

```typescript
const server = new McpServer({
  name: "my-server",      // Required
  version: "1.0.0",       // Required
  title: "My Server",     // Optional
  description: "...",     // Optional
  instructions: "...",    // Optional
});
```

#### `server.tool(name, description?, schema?, annotations?, handler)`

Register a tool.

```typescript
// Full signature
server.tool(
  "get_weather",
  "Get weather for a city",
  { city: z.string() },
  { readOnlyHint: true },
  async ({ city }, extra) => ({
    content: [{ type: "text", text: `Sunny in ${city}` }],
  })
);

// Shorthand (no description)
server.tool("ping", {}, async () => ({
  content: [{ type: "text", text: "pong" }],
}));

// Shorthand (no parameters)
server.tool("version", "Get version", async () => ({
  content: [{ type: "text", text: "1.0.0" }],
}));
```

#### `server.resource(uri, nameOrHandler?, handler?)`

Register a static resource.

```typescript
server.resource("config://app", "App Config", async (uri) => ({
  contents: [{ uri, mimeType: "application/json", text: '{"key":"value"}' }],
}));
```

#### `server.resourceTemplate(uriTemplate, handler)`

Register a dynamic resource template.

```typescript
server.resourceTemplate("users://{userId}/profile", async (uri, params) => ({
  contents: [{ uri, text: `Profile for ${params.userId}` }],
}));
```

#### `server.prompt(name, description?, handler)`

Register a prompt.

```typescript
server.prompt("greeting", "Generate a greeting", async (args) => ({
  messages: [{
    role: "user",
    content: { type: "text", text: `Hello ${args.name}!` },
  }],
}));
```

#### Notifications

```typescript
server.sendToolListChanged();
server.sendResourceListChanged();
server.sendResourceUpdated("resource://my-resource");
server.sendPromptListChanged();
server.sendLogMessage("info", "Something happened");
```

### `Server`

Low-level server with direct protocol handling.

```typescript
import { Server } from "mcp-lite";

const server = new Server(
  { name: "my-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [{ name: "ping", description: "Ping pong" }],
}));

server.setRequestHandler("tools/call", async (request) => ({
  content: [{ type: "text", text: "pong" }],
}));
```

### Transports

#### `StdioServerTransport`

```typescript
import { StdioServerTransport } from "mcp-lite";

const transport = new StdioServerTransport();
await server.connect(transport);
```

#### `WebStandardStreamableHTTPServerTransport`

```typescript
import { WebStandardStreamableHTTPServerTransport } from "mcp-lite";

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
  enableJsonResponse: true,       // Return JSON instead of SSE
  onsessioninitialized: (id) => console.log(`Session ${id}`),
  onsessionclosed: (id) => console.log(`Closed ${id}`),
});

await server.connect(transport);

// In your Hono app
app.all("/mcp", (c) => transport.handleRequest(c.req.raw));
```

### `InMemoryTransport`

For testing.

```typescript
import { InMemoryTransport } from "mcp-lite";

const transport = new InMemoryTransport();
await server.connect(transport);
```

### Error Handling

```typescript
import { McpError, ErrorCode } from "mcp-lite";

throw new McpError(ErrorCode.ToolNotFound, "Tool not found: my-tool");
```

### Type Guards

```typescript
import {
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResponse,
  isJSONRPCError,
  isInitializeRequest,
  isInitializedNotification,
  isCompletable,
} from "mcp-lite";

if (isJSONRPCRequest(message)) {
  // handle request
}
```

## Migration from Official SDK

### 1. Change the import

```diff
- import { McpServer, StdioServerTransport } from "@modelcontextprotocol/sdk";
+ import { McpServer, StdioServerTransport } from "mcp-lite";
```

### 2. Remove Express dependencies

```diff
- import express from "express";
- import cors from "cors";
+ import { Hono } from "hono";
```

### 3. Update transport instantiation

```diff
- const transport = new StreamableHTTPServerTransport({
-   sessionIdGenerator: () => crypto.randomUUID(),
- });
+ const transport = new WebStandardStreamableHTTPServerTransport({
+   sessionIdGenerator: () => crypto.randomUUID(),
+ });
```

### 4. Update route handler

```diff
- app.use("/mcp", cors());
- app.all("/mcp", express.json(), (req, res) => transport.handleRequest(req, res));
+ app.all("/mcp", (c) => transport.handleRequest(c.req.raw));
```

### 5. That's it

Everything else (tool registration, resource handling, prompts) works exactly the same.

## Protocol Compliance

Implements MCP spec **2025-11-25**:

| Feature | Status |
|---|---|
| Lifecycle (`initialize`, `initialized`, `ping`) | ✅ |
| Tools (`tools/list`, `tools/call`) | ✅ |
| Resources (`resources/list`, `resources/read`) | ✅ |
| Resource Templates | ✅ |
| Prompts (`prompts/list`, `prompts/get`) | ✅ |
| Completions (`completion/complete`) | ✅ |
| Logging (`logging/setLevel`) | ✅ |
| Progress notifications | ✅ |
| Cancellation | ✅ |
| Subscriptions | ✅ |
| Pagination (cursor-based) | ✅ |
| Streamable HTTP (POST/GET/DELETE) | ✅ |
| SSE streaming | ✅ |
| Session management | ✅ |
| Tool annotations | ✅ |

## Project Structure

```
mcp-lite/
├── src/
│   ├── index.js              # Barrel exports (from types-base.js)
│   ├── index.d.ts            # Barrel type declarations
│   ├── types-base.js         # Non-Zod exports (0ms load)
│   ├── types-base.d.ts       # Non-Zod type declarations
│   ├── types.js              # Zod schemas (lazy-loaded)
│   ├── inMemory.js           # InMemoryTransport
│   ├── server/
│   │   ├── mcp.js            # McpServer (high-level)
│   │   ├── index.js          # Server (low-level)
│   │   ├── stdio.js          # StdioServerTransport
│   │   ├── webStandardStreamableHttp.js  # HTTP transport
│   │   ├── completable.js    # Completable helper
│   │   ├── zod-compat.js     # Zod v3/v4 compatibility
│   │   └── zod-json-schema-compat.js  # Zod → JSON Schema
│   ├── shared/
│   │   ├── protocol.js       # Protocol base class
│   │   ├── transport.js      # Transport interface
│   │   └── stdio.js          # Shared stdio helpers
│   ├── validation/
│   │   ├── ajv-provider.js   # PassthroughJsonSchemaValidator
│   │   └── index.js          # Validation barrel
│   └── experimental/
│       └── tasks/            # Task-augmented execution
├── FEATURES.md               # Full feature list & limitations
├── package.json
└── tsconfig.json
```

## Known Limitations

- **No OAuth** — Use Hono middleware for auth
- **No Express transport** — Use Hono (which you should be using anyway)
- **Bun optimized** — Node.js may work but is not tested
- **Lazy Zod** — First `tools/call` has ~90ms overhead while Zod loads

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) before submitting a PR.

```bash
# Clone the repo
git clone https://github.com/srsergi0/mcp-lite.git

# Install dependencies
bun install

# Run typecheck
bun tsc --noEmit

# Run tests
bun test
```

## Security

If you discover a security vulnerability, please report it responsibly. See [SECURITY.md](SECURITY.md) for details.

## License

[MIT](LICENSE) © [srsergi0](https://github.com/srsergi0)

---

<p align="center">
  Built with ❤️ for the <a href="https://modelcontextprotocol.io">MCP</a> community.
</p>
