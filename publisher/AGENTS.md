# Publisher Backend — AGENTS.md

Backend API built with **Bun + TypeScript + Drizzle ORM + SQLite**.

## Build & Dev Commands

```bash
# Type checking (incremental, fast)
bun tsc --noEmit

# Type check in watch mode
bun tsc --noEmit --watch

# Lint & format (Biome — ultra-fast, no type checking)
bun run lint
bun run format
bun run check

# Development server
bun run dev

# Database migrations
bun run db:migrate
```

> Do **not** use `bun x tsc --noEmit` — it adds package resolution overhead. Always use `bun tsc --noEmit` directly.

## Architecture

```
src/
├── index.ts                 # Elysia server bootstrap
├── env.ts                   # Env var validation & typing
├── mcp-entry.ts             # MCP protocol integration for AI agents
├── api/router.ts            # REST endpoints
├── domain/types.ts          # Shared TypeScript types
├── infrastructure/          # External clients
│   ├── database.ts          # Drizzle + SQLite init
│   ├── queue.manager.ts     # BullMQ generic queue manager
│   ├── spotify.client.ts    # Spotify Web API
│   ├── spotiflac.client.ts  # HTTP client → downloader container
│   └── telnet.client.ts     # Telnet → liquidsoap
├── repositories/sqlite/     # Data access layer
│   ├── schema.ts            # Drizzle schema
│   ├── config.repo.ts
│   ├── library.repo.ts
│   ├── playback-state.repo.ts
│   └── playlist.repo.ts
└── services/                # Business logic
    ├── config.service.ts
    ├── download.service.ts
    ├── library.service.ts
    ├── liquidsoap.service.ts
    ├── mcp.service.ts
    └── metadata-enrichment.service.ts
```

## Code Conventions

- **Biome** for formatting and syntax linting (not type checking).
- Prefer existing Drizzle patterns in `repositories/sqlite/` — check before adding new repo files.
- Services are injected manually (no DI container). Follow the existing constructor pattern.
- SQLite via Drizzle ORM — never raw SQL unless unavoidable.
- All env vars validated in `env.ts` via type schema.

## Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test test/api.test.ts
```

Tests live in `test/` — unit tests for API and services, integration tests for full flows.

## Key Dependencies

- **Elysia** — HTTP framework
- **Drizzle ORM** — SQLite database layer
- **BullMQ + Redis** — Async job queues for downloads
- **music-metadata** — Audio tag extraction (pure JS, no ffmpeg)
- **Biome** — Formatting & linting
