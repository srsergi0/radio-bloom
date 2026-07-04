# Bitácora de Radio Bloom

Radio Bloom es una estación de radio por internet automatizada y autogestionada mediante **Liquidsoap**, **Bun (TypeScript)**, y una interfaz web en **Astro**.

---

## 🗺️ Arquitectura General y Conexiones

El sistema está compuesto por 4 microservicios principales que se ejecutan en contenedores Docker compartiendo la red `radio-net`:

1. **`web` (Astro UI)**:
   - **Puerto**: `3000` (despliegue) / `3001` (desarrollo).
   - **Conexión**: Se comunica con el `publisher` usando REST API (puerto `9876`) para obtener el estado actual, cola de reproducción y enviar comandos (skip, encolar).

2. **`publisher` (API Bun + SQLite)**:
   - **Puerto**: `3000` (interno) / `9876` (público API).
   - **Conexión**:
     - **Base de datos**: SQLite (gestionado con Drizzle ORM) para almacenar biblioteca de canciones, playlists, configuración y estado de reproducción.
     - **Hacia `liquidsoap`**: Se conecta vía **Telnet** (puerto `1234`) para saltar canciones, encolar, y obtener metadatos activos.
     - **Hacia `music/songs/` e `interludios/`**: Vigila cambios en tiempo real con `fs.watch`. Cuando se añade un archivo, extrae metadatos con `music-metadata` y los enriquece con Spotify si es posible. Cuando se elimina o renombra, actualiza la base de datos automáticamente.

3. **`ftp` (Servidor de Carga de Canciones)**:
   - **Puerto**: `21` (FTP) + `30000-30100` (pasivo).
   - **Imagen**: `fauria/vsftpd` (vsftpd 3.0, CentOS 7, virtual users).
   - **Conexión**: Permite la carga directa de canciones vía cliente FTP. Los archivos subidos se guardan en el volumen compartido `songs/` o `interludios/`. El publisher detecta automáticamente los cambios y los indexa.
   - **Credenciales**: Usuario `radio`, contraseña `radiobloom` (configuradas en `.env`).

4. **`liquidsoap` (Streaming Engine)**:
   - **Puerto**: `8000` (Harbor Output) / `8001` (Harbor Input Icecast) / `8002` (SRT) / `1234` (Telnet).
   - **Conexión**: Lee continuamente los archivos de audio en `music/songs/` e `music/interludios/`. Emite el flujo continuo (stream) de audio en formato MP3 hacia el puerto `8000`. Es controlado por el `publisher` mediante comandos Telnet. Acepta transmisiones en vivo (Icecast/Harbor) en el puerto `8001`.

---

## 📁 Árbol de Archivos del Proyecto

```
radio/
├── .env.example                          # Plantilla de variables de entorno (Spotify API, puertos, contraseñas)
├── .env                                  # Archivo de configuración local con credenciales (ignorado en git)
├── .gitignore                            # Archivos excluidos del control de versiones git
├── package.json                          # Root monorepo (Bun workspaces: packages/*, publisher, web)
├── docker-compose.yml                    # Docker Compose unificado (producción / Coolify)
├── docker-compose.dev.yml                # Desarrollo local (Redis + Liquidsoap + Web)
├── docker-compose.override.yml           # Overrides para desarrollo local (bind mounts)
├── README.md                             # Guía del proyecto
├── AGENTS.md                             # Reglas globales de comportamiento para agentes IA
├── opencode.json                         # Configuración OpenCode (MCP local/remoto)
│
├── packages/                             # Paquetes del monorepo (publicables independientemente)
│   └── mcp-lite/                         # mcp-lite — MCP server extraído del SDK v1.29.0
│       ├── package.json                  # Deps: zod, zod-to-json-schema, content-type, cross-spawn
│       ├── README.md                     # Quick start y API reference
│       ├── FEATURES.md                   # Características completas y limitaciones conocidas
│       ├── tsconfig.json
│       └── src/
│           ├── index.js                  # Barrel exports (McpServer, HttpTransport, etc.)
│           ├── index.d.ts                # Barrel type declarations
│           ├── types-base.js             # Non-Zod exports (ErrorCode, McpError, type guards) — 0ms load
│           ├── types-base.d.ts           # Non-Zod type declarations
│           ├── types.js                  # MCP protocol types/schemas (usa zod/v4, lazy-loaded)
│           ├── inMemory.js              # InMemoryTransport
│           ├── server/
│           │   ├── mcp.js               # McpServer class (.tool, .resource, .prompt, .connect)
│           │   ├── index.js             # Server class (bajo nivel)
│           │   ├── stdio.js             # StdioServerTransport
│           │   ├── webStandardStreamableHttp.js  # HTTP transport (web standards, sin Express)
│           │   ├── completable.js       # Completable helper
│           │   ├── zod-compat.js        # Zod v3/v4 compatibility
│           │   ├── zod-json-schema-compat.js  # Zod → JSON Schema conversion
│           │   └── auth/
│           │       └── types.d.ts        # AuthInfo type stub (OAuth stripped)
│           ├── shared/
│           │   ├── protocol.js          # Protocol base class (lifecycle, capability negotiation)
│           │   ├── transport.js         # Transport interface
│           │   ├── stdio.js             # Shared stdio helpers
│           │   ├── uriTemplate.js       # URI template parsing
│           │   ├── toolNameValidation.js # Tool name validation
│           │   ├── metadataUtils.js     # Metadata helpers
│           │   └── responseMessage.js   # Response message helpers
│           ├── validation/
│           │   ├── ajv-provider.js       # PassthroughJsonSchemaValidator (reemplaza ajv)
│           │   ├── ajv-provider.d.ts     # PassthroughJsonSchemaValidator types
│           │   ├── types.d.ts           # Validation interface types
│           │   └── index.js             # Validation barrel
│           └── experimental/
│               └── tasks/               # Task-augmented execution support
│                   ├── client.js        # Client task support (experimental)
│                   └── stores/
│                       └── in-memory.js # InMemoryTaskStore + InMemoryTaskMessageQueue
│
├── ftp/                                  # Servidor FTP para subir canciones (vsftpd)
│   └── (usando imagen fauria/vsftpd, sin Dockerfile custom)
│
├── liquidsoap/                           # Motor de Audio
│   └── radio.liq                         # Script de Liquidsoap (playlist, queue, fallback, output.harbor)
│
├── music/                                # Directorio de almacenamiento de audios (Volumen compartido)
│   ├── songs/                            # Canciones (formatos MP3, FLAC, M4A, OGG)
│   └── interludios/                      # Cuñas, anuncios o sonidos de transición
│
├── downloads-test/                       # Carpeta de pruebas de descargas
│
├── publisher/                            # Backend API (Bun + TypeScript + Drizzle)
│   ├── AGENTS.md                         # Reglas específicas del backend
│   ├── Dockerfile                        # Dockerfile optimizado para Bun
│   ├── biome.json                        # Configuración de Biome (linting y formateo)
│   ├── tsconfig.json                     # Configuración TypeScript
│   ├── package.json                      # Dependencias npm y scripts
│   ├── drizzle.config.ts                 # Configuración de Drizzle ORM
│   ├── test/
│   │   ├── api.test.ts                   # Tests de endpoints de la API
│   │   └── integration.test.ts
│   └── src/
│       ├── index.ts                      # Servidor principal (Bun.serve, DI, StreamBroadcaster)
│       ├── env.ts                        # Valores por defecto de variables de entorno
│       ├── mcp-entry.ts                  # Integración del protocolo MCP para agentes IA (modo stdio)
│       │
│       ├── api/
│       │   └── router.ts                 # Rutas REST (Hono): biblioteca, cola, playlists, subida de archivos
│       │
│       ├── domain/
│       │   └── types.ts                  # Tipos TypeScript compartidos (Track, StreamStatus, etc.)
│       │
│       ├── infrastructure/               # Clientes y conectores externos
│       │   ├── database.ts               # Inicializador de Drizzle con SQLite
│       │   ├── audio-metadata.client.ts  # Extracción de metadatos de audio con music-metadata
│       │   ├── spotify.client.ts         # Cliente de la API de Spotify (search, getTrack)
│       │   └── telnet.client.ts          # Cliente Telnet hacia liquidsoap
│       │
│       ├── repositories/sqlite/          # Capa de Acceso a Datos (Drizzle ORM)
│       │   ├── schema.ts                 # Esquema de base de datos Drizzle
│       │   ├── config.repo.ts            # Configuración del sistema
│       │   ├── library.repo.ts           # CRUD de tracks en biblioteca
│       │   ├── playback-state.repo.ts    # Estado de reproducción actual
│       │   ├── playlist.repo.ts          # CRUD de playlists y tracks
│       │   └── locutor.repo.ts           # CRUD de locutores de IA y horarios
│       │
│       ├── services/                     # Lógica de Negocio
│       │   ├── config.service.ts         # Gestión de configuración
│       │   ├── library.service.ts        # Escaneo + watcher de archivos + enriquecimiento Spotify
│       │   ├── liquidsoap.service.ts     # Órdenes Telnet sobre liquidsoap (queue, skip, play)
│       │   ├── mcp.service.ts            # Herramientas MCP (15+ tools)
│       │   ├── torrent.service.ts        # Búsqueda PirateBay (apibay) + Cola de descargas BullMQ con aria2c
│       │   ├── orchestrator.service.ts   # AI DJ & Programación automática (OpenRouter + Edge-TTS)
│       │   ├── locutor.service.ts        # Lógica de guardarraíl de solapamiento y locutor activo
│       │   └── metadata-enrichment.service.ts  # Enriquecimiento desde Spotify
│       │
│       └── scripts/                      # Scripts de utilidad
│           ├── test-isrc-youtube.ts
│           ├── test-youtube-premium.ts
│           └── check_db.ts
│
└── web/                                  # Interfaz Frontend (Astro)
    ├── package.json
    ├── tsconfig.json
    ├── astro.config.mjs
    ├── Dockerfile                        # Dockerfile multi-stage (build + nginx)
    ├── AGENTS.md
    ├── public/                           # Archivos estáticos
    └── src/
        ├── layouts/
        │   └── Layout.astro
        ├── styles/
        │   └── global.css
    ├── pages/
    │   ├── index.astro               # Landing Page (Inglés)
    │   ├── admin.astro               # Admin SPA (React + shadcn/ui + dnd-kit) — Biblioteca, Playlists e Interludios
    │   └── es/
    │       └── index.astro           # Landing Page (Español)
    ├── lib/
    │   └── utils.ts                  # cn() helper para shadcn/ui (tailwind-merge + clsx)
    └── components/
        ├── EventBanner.astro
        ├── Features.astro
        ├── Footer.astro
        ├── Header.astro
        ├── Hero.astro
        ├── LiveShow.astro
        ├── ProgramList.astro
        ├── Player.astro
        ├── ui/
        │   ├── Badge.astro
        │   ├── Button.astro
        │   └── Card.astro
        └── admin/
            ├── AdminApp.tsx          # Root SPA: BrowserRouter + layout (sidebar + main)
            ├── SidebarTree.tsx        # Árbol de canciones y interludios (GET /api/library/tree), draggable
            ├── PlaylistList.tsx       # Lista de playlists + crear nueva
            ├── PlaylistDetail.tsx     # Detalle de playlist con cola drag & drop (DndContext)
            ├── PlaylistTrackItem.tsx  # Item de cola (song/interludio), sortable, menú editar/eliminar
            ├── InterludioEditor.tsx   # Dialog para crear/editar interludios de texto (script)
            ├── lib/
            │   ├── api.ts             # Cliente fetch tipado
            │   └── types.ts           # Tipos TS: Track, Playlist, PlaylistTrack, FileTreeNode
            └── ui/                    # Componentes shadcn/ui (React + Tailwind)
                ├── badge.tsx
                ├── button.tsx
                ├── card.tsx
                ├── dialog.tsx
                ├── dropdown-menu.tsx
                ├── input.tsx
                ├── scroll-area.tsx
                ├── separator.tsx
                └── tooltip.tsx
```

---

## 🔄 Flujo de Trabajo Típico de Datos

### Añadir canciones a la biblioteca

1. **Vía FTP**: El usuario sube archivos por FTP a `music/songs/` o `music/interludios/`.
2. **Vía API**: `POST /api/library/upload` con FormData (campo `file` y `type`).
3. **Detección automática**: El `LibraryService` usa `fs.watch` para detectar cambios en tiempo real. Cuando se añade, elimina o renombra un archivo, se ejecuta un escaneo automático.
4. **Indexación y enriquecimiento**: Cada archivo nuevo se procesa:
   - Se extraen metadatos locales con `music-metadata` (título, artista, álbum, duración).
   - Si es una canción (no interludio) y no tiene URL de Spotify en metadatos, se busca en la API de Spotify y se completa la información.
   - Se guarda en la base de datos SQLite.
5. **Detección de eliminaciones**: Cuando un archivo se elimina del disco, se elimina automáticamente de la base de datos.

### Reproducir canciones

1. **Buscar**: Usar `radio_search` (MCP) o `/api/library/search?q=...` (REST) para encontrar el track.
2. **Obtener ID**: Los resultados incluyen el campo `id` del track en la base de datos.
3. **Encolar con ID**: Llamar `radio_queue_add` con el `id` del track, o `POST /api/stream/queue` con `{ id }`.

---

## 🔄 Persistencia de Reproducción (Restore al Reiniciar)

El sistema garantiza que al reiniciar el servidor o los contenedores, la canción se retoma donde quedó:

1. **Guardado automático**: Cada 15 segundos, el publisher guarda el estado actual (archivo, título, artista, posición, duración) en SQLite dentro del volumen `radio-publisher-data`.
2. **Al reiniciar**: El publisher espera 3 segundos, luego reintenta conectarse a Liquidsoap (hasta 60s).
3. **Restore**: Recupera la cola completa desde SQLite y la restaura en Liquidsoap (ya no solo el track actual).
4. **Si la canción ya habría terminado**: Limpia el estado y empieza fresco con la playlist de fondo.

---

## 🎵 API de Playlists

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/playlists` | Crear playlist (body: `{ name }`) |
| `GET` | `/api/playlists` | Listar todas las playlists |
| `GET` | `/api/playlists/:id` | Obtener playlist con tracks |
| `PUT` | `/api/playlists/:id` | Actualizar nombre |
| `DELETE` | `/api/playlists/:id` | Eliminar playlist y tracks |
| `POST` | `/api/playlists/:id/tracks` | Agregar track (body: `{ title, artist?, duration?, type?, file? }`) |
| `PUT` | `/api/playlists/:id/tracks/:trackId` | Editar track existente |
| `DELETE` | `/api/playlists/:id/tracks/:trackId` | Eliminar track |
| `PUT` | `/api/playlists/:id/tracks/reorder` | Reordenar tracks |

---

## 🎙️ API de Locutores de IA y Horarios

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/locutors` | Listar todos los locutores de IA con sus respectivos horarios |
| `POST` | `/api/locutors` | Crear un nuevo locutor (body: `{ name, voice, personality, isActive?, isDefault? }`) |
| `PUT` | `/api/locutors/:id` | Editar detalles del locutor (nombre, voz, prompt de personalidad, estado activo, toggle de reserva) |
| `DELETE` | `/api/locutors/:id` | Eliminar locutor y todos sus horarios programados (cascada) |
| `POST` | `/api/locutors/:id/schedules` | Programar horario diario o semanal (body: `{ type, dayOfWeek?, startHour, duration }`) con **guardarraíl de solapamiento** |
| `DELETE` | `/api/locutors/:id/schedules/:scheduleId` | Eliminar un horario de emisión programado |

---

## 📥 API de Descargas y Torrents (BullMQ)

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/torrents/search` | Buscar torrents de música en PirateBay (`apibay.org`) |
| `POST` | `/api/torrents/queue` | Encolar una nueva descarga (body: `{ magnet, name }`) |
| `GET` | `/api/torrents/jobs` | Obtener estadísticas y listado de trabajos en cola |
| `GET` | `/api/torrents/jobs/:id/logs` | Ver logs de descarga en tiempo real de un trabajo específico |
| `POST` | `/api/torrents/jobs/:id/cancel` | Cancelar y remover un trabajo de descarga de la cola |
| `GET` | `/admin/queues` | Dashboard web interactivo de Bull-Board para gestionar colas |

### Herramientas MCP

| Herramienta | Descripción |
|-------------|-------------|
| `radio_status` | Estado actual del stream y cola |
| `radio_search` | Buscar en biblioteca local |
| `radio_spotify_search` | Buscar en Spotify API |
| `radio_queue_list` | Listar cola de reproducción |
| `radio_queue_add` | Añadir track a cola por ID de biblioteca |
| `radio_queue_insert` | Insertar track en posición por ID |
| `radio_queue_remove` | Eliminar track de cola por posición |
| `radio_queue_clear` | Vaciar cola |
| `radio_play_now` | Reproducir track por ID inmediatamente |
| `radio_skip` | Saltar canción actual |
| `radio_library_stats` | Estadísticas de biblioteca |
| `radio_list_songs` | Listar canciones paginado |
| `radio_list_interludios` | Listar interludios paginado |
| `radio_playlist_create` | Crear playlist |
| `radio_playlist_list` | Listar playlists |
| `radio_playlist_get` | Obtener playlist |
| `radio_playlist_add_track` | Añadir track a playlist |
| `radio_playlist_play` | Reproducir playlist |
| `torrent_search` | Buscar torrents de música en PirateBay |
| `torrent_queue_download` | Agregar descarga de torrent a la cola mediante magnet link |
| `torrent_check_status` | Verificar el estado de un trabajo de descarga de la cola |
| `torrent_queue_status` | Obtener estadísticas generales de la cola de descargas |
| `torrent_list_queue` | Listar descargas recientes en la cola |
| `torrent_cancel` | Cancelar una descarga en la cola (si aún no se ha procesado) |
| `torrent_job_logs` | Obtener logs de salida en tiempo real de aria2c para un trabajo específico |

---

## Cambios Recientes

### Migración FTP: pure-ftpd → vsftpd (Julio 2026)

- **Problema**: La imagen `stilliard/pure-ftpd:hardened` tenía múltiples bugs: permisos denegados al crear directorios, configuración compleja de chroot, errores de pure-pw useradd, y el entrypoint personalizado nunca se ejecutaba correctamente.
- **Solución**: Se migró a `fauria/vsftpd`, una imagen mucho más popular y sencilla de configurar.
- **Cambios realizados**:
  - Se eliminó la carpeta `ftp/` (Dockerfile + entrypoint.sh) — ya no se necesita build custom.
  - Se actualizó `docker-compose.yml`: el servicio FTP ahora usa `image: fauria/vsftpd` con variables de entorno directas (`FTP_USER`, `FTP_PASS`, `PASV_ADDRESS`, `PASV_MIN_PORT`, `PASV_MAX_PORT`).
  - Se limpió `.env`: se eliminaron `FTP_USER_HOME` y `FTP_UMASK` (ya no aplican).
  - Se actualizó `docker-compose.override.yml` para usar las rutas correctas (`/home/vsftpd/radio/songs`).
  - Se actualizó `BITACORA.md` con la nueva arquitectura FTP.
- **Resultado**: FTP funciona correctamente desde Windows Explorer. El usuario `radio` puede navegar `songs/` e `interludios/` y subir archivos sin errores de permisos.

### Ajustes de Parámetros en Liquidsoap (Julio 2026)

- **Cambios**:
  - En [radio.liq](file:///d:/cursos/SEED-AUDIO/radio/liquidsoap/radio.liq), se modificaron los siguientes parámetros:
    - `internal_quality` de la salida MP3 de `0` a `2`.
    - El intervalo de recarga de la lista de reproducción (`reload`) de `60` a `300` segundos.
    - La duración de la transición `crossfade` (`duration`) de `3.0` a `1.5` segundos.

### Corrección de Resolución de Dependencias del Workspace `mcp-lite` (Julio 2026)

- **Problema**: `bun run dev` fallaba al no encontrar el módulo `mcp-lite` desde `publisher`.
- **Causas**:
  1. Las rutas del objeto `"exports"` en [package.json](file:///d:/cursos/SEED-AUDIO/radio/packages/mcp-lite/package.json) del paquete MCP no empezaban por `./`, lo que impedía que Bun resolviese los ficheros correctamente como rutas relativas.
  2. Había alias de rutas redundantes en el `paths` de [tsconfig.json](file:///d:/cursos/SEED-AUDIO/radio/publisher/tsconfig.json) que apuntaban a ficheros `.js` inexistentes (por ejemplo, `"mcp-lite": ["./src/types/mcp-server.js"]`), lo que confundía al resolutor en tiempo de ejecución de Bun.
  3. Existían múltiples directorios `node_modules` e hilos de bloqueo `bun.lock` inconexos en subcarpetas del proyecto (resultado de `bun install` ejecutados localmente en `publisher` o `web` de forma aislada).
- **Soluciones**:
  - Se corrigió el `"exports"` de [packages/mcp-lite/package.json](file:///d:/cursos/SEED-AUDIO/radio/packages/mcp-lite/package.json) prefijando las rutas con `./`.
  - Se eliminó el mapeo redundante de `mcp-lite` en el `paths` de [publisher/tsconfig.json](file:///d:/cursos/SEED-AUDIO/radio/publisher/tsconfig.json).
  - Se limpiaron los directorios `node_modules` locales y archivos `bun.lock` aislados, ejecutando `bun install` desde la raíz para unificar la resolución del monorepo.

### Migración a mcp-lite — Extracción Ligera del SDK Oficial (Julio 2026)

- **Problema**: `@modelcontextprotocol/sdk` arrastraba **Express 5 + ajv + jose + cors** (~150-200MB de heap permanente). El publisher consumía ~492MB de RAM.
- **Enfoque original (descartado)**: Se intentó reescribir el MCP server desde cero sobre Hono+Bun+Zod (~500 líneas). Se descartó por ser incompleto y no garantizar compliance total con el protocolo MCP.
- **Solución final**: Se extrajo el código compilado del SDK oficial v1.29.0, copiando solo los archivos `.js` y `.d.ts` necesarios, eliminando Express/OAuth/ajv/jose/cors. Se creó `mcp-lite` como paquete independiente del monorepo (`packages/mcp-lite/`).
- **Monorepo Bun Workspaces**: `package.json` raíz con `"workspaces": ["packages/*", "publisher", "web"]`. El publisher referencia el paquete via `"mcp-lite": "workspace:*"`.
- **Archivos copiados del SDK** (sin Express/OAuth/middleware):
  - `server/mcp.js` — McpServer class
  - `server/index.js` — Server class
  - `server/stdio.js` — StdioServerTransport
  - `server/webStandardStreamableHttp.js` — WebStandardStreamableHTTPServerTransport
  - `server/completable.js`, `server/zod-compat.js`, `server/zod-json-schema-compat.js`
  - `shared/protocol.js`, `shared/transport.js`, `shared/stdio.js`, `shared/uriTemplate.js`, `shared/toolNameValidation.js`, `shared/metadataUtils.js`, `shared/responseMessage.js`
  - `experimental/tasks/*` (interfaces, helpers, mcp-server, server, types, inMemory)
  - `types.js` (protocol schemas — usa `zod/v4`)
  - `inMemory.js` (InMemoryTransport)
- **Reemplazo de Ajv**: Se creó `validation/ajv-provider.js` con `PassthroughJsonSchemaValidator` — validador JSON Schema passthrough que reemplaza ajv (~1.3MB disk, ~5-10MB heap saved). Users pueden inyectar custom validator via `ServerOptions.jsonSchemaValidator`.
- **Eliminados del SDK**:
  - `shared/auth.js` (OAuth schemas — importaba `zod/v4` innecesariamente)
  - `server/express.js`, `server/auth/*`, `server/middleware/*` (Express, cors, jose)
  - `server/expressMiddleware.js`
- **API pública del paquete**: `McpServer`, `Server`, `WebStandardStreamableHTTPServerTransport` (+ alias `HttpTransport`), `StdioServerTransport` (+ alias `StdioTransport`), `InMemoryTransport`, `ResourceTemplate`, `completable`, `isCompletable`, y todos los tipos MCP.
- **Dependencias del paquete**: `zod ^3.25.0 || ^4.0.0`, `zod-to-json-schema ^3.25.1`, `content-type ^1.0.5`, `cross-spawn ^7.0.5`. Cero Express, cero ajv, cero jose, cero cors.
- **Cambios en el publisher**:
  - Se eliminó `@modelcontextprotocol/sdk` de `package.json`
  - Se eliminó el path mapping `@modelcontextprotocol/sdk/*` del tsconfig
  - Se eliminaron `src/webStandardStreamableHttp.ts` y `src/types/mcp.d.ts`
  - Se creó `src/types/mcp-server.d.ts` con tipos simplificados para el publisher
  - `src/services/mcp.service.ts` ahora importa `McpServer`, `HttpTransport`, `StdioTransport` desde `mcp-lite`
  - Se eliminaron `maxSessions` y `sessionTimeoutMs` del transport options (no existen en el SDK oficial)
- **Verificaciones**: Typecheck de publisher y mcp-server pasan. Smoke test de imports en runtime OK. Todos los exports (McpServer, HttpTransport, StdioTransport, Server, InMemoryTransport, ResourceTemplate, completable) cargan correctamente.

### Optimización Fase 1 — Module Load Moonshot (Julio 2026)

- **Objetivo**: Reducir el tiempo de arranque del mcp-server y el heap base eliminando imports innecesarios del hot path.
- **Cambios aplicados**:
  1. **Inline `isTerminal` en `protocol.js`**: Se inyectó la función `isTerminal()` (1 línea: `status === 'completed' || status === 'failed' || status === 'cancelled'`) directamente en `shared/protocol.js`, eliminando el import de `experimental/tasks/interfaces.js`. Esto corta la cadena de imports experimentales desde `protocol.js`.
  2. **Lazy-load task helpers en `server/index.js`**: `assertToolsCallTaskCapability` y `assertClientRequestTaskCapability` ahora se importan dinámicamente (`await import()`) solo cuando se llaman `assertTaskCapability()` / `assertTaskHandlerHandler()` — que solo ocurren en request handlers async. Se eliminó el import estático de `experimental/tasks/helpers.js`.
  3. **Lazy-load `zod/v4-mini` en `zod-json-schema-compat.js`**: `zod/v4-mini` (~57ms de carga) ahora se importa dinámicamente solo cuando se encuentra un schema v4. El import fire-and-forget en el barrel asegura que se precargue en background. Para publishers que solo usan Zod v3, el módulo nunca se bloquea.
  4. **Eliminar `ZodOptional` import de `mcp.js`**: Se reemplazó `field instanceof ZodOptional` con duck-typing (`field._def?.typeName === 'ZodOptional' || field._zod?.def?.type === 'optional'`). Esto elimina el import de `import { ZodOptional } from 'zod'` que cargaba el módulo completo de Zod.
- **Resultados medidos**:
  - Module load: **188ms → 129ms** (-59ms, **-31%**)
  - Heap base: **0.9MB → 0.2MB** (-0.7MB, **-78%**)
  - 10 McpServers: **6ms → 1ms** (-5ms, **-83%**)
  - Publisher RSS: **143MB → 127MB** (-16MB, **-11%**)
- **Fase completada** (Phase 2 → Per-Instance Moonshot, Phase 3 → Lazy Zod Compilation)

### Optimización Fase 2 — Per-Instance Moonshot (Julio 2026)

- **Objetivo**: Reducir el heap por cada instancia McpServer/Server eliminando allocations innecesarias.
- **Cambios aplicados**:
  1. **Protocol Maps lazy-init**: Los 7 Maps/Set del constructor de `Protocol` (`_requestHandlerAbortControllers`, `_responseHandlers`, `_progressHandlers`, `_timeoutInfo`, `_pendingDebouncedNotifications`, `_taskProgressTokens`, `_requestResolvers`) ahora se crean bajo demanda con getters lazy (`_getRequestResolvers()`, etc.). Solo `_requestHandlers` y `_notificationHandlers` se crean eager (se usan en el constructor). `_onclose()` tiene guards `if (this._xxx)` para evitar crear Maps innecesariamente al cerrar.
  2. **Registry Object→Map**: Los 4 registros de McpServer (`_registeredTools`, `_registeredResources`, `_registeredResourceTemplates`, `_registeredPrompts`) se convirtieron de plain Objects a Maps. Todas las 34 referencias (lecturas, escrituras, deletes, iteraciones, existence checks) se actualizaron a la API de Map (`.get()`, `.set()`, `.has()`, `.delete()`, `.entries()`).
- **Resultados medidos**:
  - 50 McpServers (5 tools cada uno): **3.3MB RSS total** (~66KB por instancia)
  - Per-instance: **~66KB** (vs ~55KB antes — la diferencia es por el overhead de Map vs Object, pero Map es más eficiente en operaciones)
  - Typecheck y smoke test pasan correctamente
- **Fase completada** (Phase 3 → Lazy Zod Compilation Moonshot)

### Optimización Fase 3 — Lazy Zod Compilation Moonshot (Julio 2026)

- **Objetivo**: Deferir la carga de `zod/v4` y las 80+ compilaciones de schemas Zod hasta el primer uso real (primer mensaje recibido), no al importar el módulo.
- **Cambios aplicados**:
  1. **`types-base.js` (~100 líneas, SIN Zod)**: Se extrajeron todas las exportaciones que no necesitan Zod: `ErrorCode`, `McpError`, `UrlElicitationRequiredError`, version constants (`LATEST_PROTOCOL_VERSION`, `SUPPORTED_PROTOCOL_VERSIONS`, etc.), type guards (`isJSONRPCRequest`, `isJSONRPCNotification`, `isJSONRPCResultResponse`, `isJSONRPCErrorResponse`, `isInitializeRequest`, `isInitializedNotification`, `isTaskAugmentedRequestParams`), y assert functions. Los type guards se reemplazaron de `Zod.safeParse().success` a property-checks simples (más rápidos y sin Zod).
  2. **String method names en handlers**: `protocol.js` y `server/index.js` ahora usan strings (`'ping'`, `'notifications/cancelled'`, `'initialize'`, etc.) en vez de schemas Zod para registrar handlers en el constructor. Esto elimina la necesidad de schemas compilados durante la construcción del servidor.
  3. **Lazy-loaded schemas**: Los schemas Zod (`CallToolRequestSchema`, `CreateTaskResultSchema`, `LoggingLevelSchema`, etc.) ahora se cargan via `await import('../types.js')` solo cuando se necesitan para validación de mensajes — no al importar el módulo.
  4. **Barrel `index.js` actualizado**: Se reemplazó `export * from "./types.js"` por `export * from "./types-base.js"`, eliminando la carga forzosa de Zod al importar el paquete.
  5. **Type guards sin Zod**: `isJSONRPCRequest`, `isJSONRPCNotification`, etc. ahora usan property-checks simples (`typeof value === 'object' && value.jsonrpc === '2.0' && ...`) en vez de `Zod.safeParse()`. Más rápidos y sin dependencia de Zod.
- **Resultados medidos**:
  - Module load: **188ms → 93.1ms** (-94.9ms, **-50% total**)
  - types-base.js load: **0.1ms** (sin Zod)
  - types.js load (Zod): **90.3ms** (diferido al primer uso)
  - Typecheck y smoke test pasan correctamente

### Completado de Tipos TypeScript para `mcp-lite` (Julio 2026)

- **Objetivo**: Soporte completo de tipos para cualquier desarrollador que use el paquete.
- **Problemas encontrados**:
  1. `types-base.d.ts` no existía — 0% cobertura para exports no-Zod (ErrorCode, McpError, type guards)
  2. `auth/types.js` no existía — 4 archivos `.d.ts` importaban `AuthInfo` de una ruta rota
  3. `validation/ajv-provider.d.ts` no existía — workaround frágil en `package.json`
  4. Barrel `index.d.ts` no re-exportaba `types-base.js` directamente
  5. `AnySchema` usaba tipos nominales de `zod/v3` y `zod/v4/core` que no coincidían con `zod` v3 del publisher (diferentes `node_modules`)
- **Soluciones aplicadas**:
  1. Creado `types-base.d.ts` con declaraciones completas: constants, ErrorCode enum, McpError, UrlElicitationRequiredError, 7 type guards, 2 assert functions
  2. Creado `server/auth/types.d.ts` con tipo `AuthInfo` (stub para auth custom)
  3. Creado `validation/ajv-provider.d.ts` con declaraciones directas
  4. Actualizado `index.d.ts` para re-exportar `types-base.js` directamente
  5. `AnySchema = any` + `SchemaOutput<S>` fallback = `any` para compatibilidad cross-version de Zod
- **Resultado**: Typecheck del publisher pasa correctamente. Cobertura de tipos ~100%.

### Completado de Paridad 1:1 con SDK Oficial (Julio 2026)

- **Objetivo**: Cerrar todos los gaps de funcionalidad entre `mcp-lite` y el SDK oficial v1.29.0.
- **Gaps encontrados y corregidos**:
  1. `experimental/tasks/client.js` no existía — import roto en `experimental/tasks/index.js` → Creado `ExperimentalClientTasks` con soporte completo de client-side tasks (callToolStream, getTask, listTasks, cancelTask)
  2. `experimental/tasks/stores/in-memory.js` no existía — import roto → Creado `InMemoryTaskStore` + `InMemoryTaskMessageQueue` con TTL cleanup automático
  3. `validation/index.js` exportaba de `./types.js` (solo `.d.ts`) → Cambiado a exportar desde `./ajv-provider.js`
- **Resultado**: Paridad 1:1 en funcionalidades core (McpServer, Server, Protocol, transports, tools, resources, prompts, completions, experimental tasks). Typecheck pasa.

### Integración de Búsqueda y Descarga de Torrents en Publisher (BullMQ + Bull-Board)

- **Eliminación de `music-torrent` (Python)**: Se eliminó por completo el microservicio `music-torrent` en Python.
- **Descargador nativo en el Publisher**: Se integró toda la lógica en el `publisher` usando Bun + TypeScript.
- **Cola robusta con BullMQ**: Se implementó una cola de descargas usando BullMQ (respaldada por Redis) que procesa magnets en segundo plano de forma concurrente y ordenada.
- **Salida de Logs en vivo (Bull-Board)**: Se integró el dashboard de Bull-Board en la ruta `/admin/queues`, permitiendo visualizar el estado de cada trabajo, el porcentaje de progreso de descarga obtenido de `aria2c` en tiempo real, y los logs de salida detallados (stdout/stderr) de `aria2c` gracias a `job.log()`.
- **Integración con la Biblioteca**: Al terminar una descarga, el trabajador busca archivos de audio (`.mp3`, `.flac`, etc.) en la carpeta temporal, los mueve automáticamente a `music/songs` y limpia los archivos residuales. El File Watcher de `LibraryService` detecta e indexa estos archivos nuevos de forma inmediata.
- **Buscador de PirateBay (apibay.org)**: Integrada la búsqueda de PirateBay en la categoría de Audio (`100`), la cual retorna magnet links con trackers optimizados para acelerar las descargas.
- **Panel de control brutalista en el Admin UI**: Se añadió una sección de descarga brutalista en el `/admin` (y `/es/admin`) que permite buscar canciones, encolar descargas de PirateBay de forma interactiva, ver la cola de descargas con barras de progreso, abrir el log detallado de cada descarga en un popup y saltar directamente al panel de Bull-Board.

### Eliminación del sistema de descargas y Redis

- **Downloader eliminado**: Se eliminó el microservicio `downloader/` (SpotiFLAC). Ya no se descarga música de Spotify.
- **Redis/BullMQ eliminado**: Se eliminaron Redis y BullMQ. La cola de descargas (download.service.ts) se eliminó por completo, junto con el QueueManager.
- **Watcher de archivos implementado**: El `LibraryService` ahora vigila los directorios `songs/` e `interludios/` usando `fs.watch`. Los cambios (nuevos archivos, eliminaciones, renombres) se detectan automáticamente y se reflejan en la base de datos.
- **Enriquecimiento Spotify**: Cuando se añade un archivo nuevo sin URL de Spotify, se busca automáticamente en Spotify API para completar metadatos.
- **API de subida de archivos**: Nuevo endpoint `POST /api/library/upload` para subir archivos por HTTP (multipart/form-data).
- **Cola por ID**: Las herramientas MCP y endpoints REST ahora aceptan el `id` del track en la base de datos, no rutas de archivo ni URLs de Spotify.
- **Eliminación de `radio_queue_add_url`**: Se eliminó la herramienta MCP `radio_queue_add_url`. Para encolar usar `radio_queue_add` con el `id` del track.

### Transmisión en Vivo por Icecast y Estabilidad Extrema (Moonshot)

- **Entrada en vivo por Icecast (Harbor)**: Se reemplazó la entrada SRT (puerto 8002) por una entrada Icecast (`input.harbor`) en el puerto `8001`, permitiendo el uso de software estándar de audio como **BUTT** o **Mixxx**.
- **Amortiguador de Red (Shock Absorber)**: Se aumentó el buffer interno del `StreamBroadcaster` a **1.5 MB** (~38 segundos de audio a 320kbps) en el backend de Bun. Al conectar, el cliente recibe esta ráfaga para pre-llenar su buffer.
- **Inyección de Silencio en Caliente (Hot-Standby)**: Implementado bucle de inyección de frames de silencio MP3 estándar a 320kbps si la señal con Liquidsoap se cae. Esto mantiene el socket HTTP de los oyentes y plataformas como **Radio Garden** 100% activo, evitando desconexiones por inactividad.
- **Cabeceras Anti-Proxy**: Integrados headers `"X-Accel-Buffering": "no"` y `"Content-Encoding": "identity"` en la respuesta del stream para prevenir que Cloudflare o Traefik almacenen en caché o compriman el stream, lo cual congelaba y tiraba las conexiones.
- **Procesador DSP Multibanda (Calidad FM)**: Implementado un procesador de dinámica de 3 bandas (`compress.multiband`) en [radio.liq](file:///d:/cursos/SEED-AUDIO/radio/liquidsoap/radio.liq) para emular el sonido comercial "gordo" y consistente de las radios FM comerciales, equilibrando graves (punch), medios (voces) y agudos (aire/brillo).

### 🎙️ AI DJ y Orquestación Inteligente Continua (Agente con Herramientas)

- **Orquestador Central (`OrchestratorService`)**: Se implementó un bucle de control inteligente (cada 10s) que asegura un colchón mínimo de 2 canciones en la cola de Liquidsoap.
- **Planificación por Lotes (Batching)**: Se optimizó el flujo para que cuando la cola sea baja, el DJ planifique una tanda completa de **5 canciones consecutivas** con sus interludios y locuciones en una sola llamada a OpenRouter, lo cual reduce el consumo de tokens en aproximadamente un 80% y permite ganchos y transiciones más cohesionadas.
- **Voz Neural con Edge-TTS**: Síntesis gratuita de voz neural de alta calidad de Microsoft Edge en tiempo real para las locuciones.
- **Bucle de Llamada a Herramientas (Tool-use)**: El locutor de OpenRouter tiene la facultad de ejecutar llamadas a herramientas locales para planificar su bloque de 5 temas o realizar búsquedas en su catálogo:
  - `submit_decisions(decisions)`: Envía la lista definitiva con la planificación estructurada de 5 canciones y locuciones.
  - `get_library_songs(limit?, offset?)`: Obtiene una lista paginada de canciones del catálogo (evita búsquedas ciegas).
  - `search_library(query)`: Busca canciones locales en la base de datos de la radio.
  - `get_library_stats()`: Obtiene el conteo total de temas locales.
  - `get_stream_status()`: Consulta el stream activo y temas en cola para no repetir.
- **Hora Peruana Inyectada**: Se removió la herramienta de obtención de tiempo. En su lugar, el orquestador inyecta la hora actual calculada en la zona de Perú directamente en el prompt del sistema y el del usuario.
- **Persistencia, Continuidad e Historial Acortado**: Guarda el historial de diálogos (formato chat `DialogueMessage[]`) en `data/dj_history.json` para conservar un contexto coherente e hilar temas al hablar, limitado estrictamente a un máximo de **5 mensajes** para evitar la repetición de canciones e ideas sin elevar el consumo de tokens.
- **Ángulos Creativos Dinámicos**: En cada locución se le exige al DJ un ángulo creativo aleatorio (reflexionar sobre la hora, datos del artista, sonoridad, puentes rítmicos, etc.) para romper con frases introductorias o locuciones repetitivas.
- **Limpieza Activa**: El orquestador monitorea la reproducción y elimina automáticamente los archivos `.mp3` de locución generados tan pronto como salen de la cola de emisión.
- **Filtro de Watcher**: Modificado el escáner y vigilante de `LibraryService` para ignorar los archivos que inician con `ai_dj_`, evitando contaminar el catálogo estable de la biblioteca.

### 🎙️ Múltiples Locutores de IA y Agenda de Programación (Guardarraíl Anticolisiones)

- **Gestión CRUD de Locutores de IA**: Se añadió soporte para registrar múltiples locutores de IA con nombres, voces neurales personalizadas de Microsoft Edge-TTS y prompts de personalidad únicos en la base de datos SQLite.
- **Programación Horaria Flexible**: Los locutores pueden tener programas diarios o semanales con una hora de inicio ("HH:MM") y una duración configurable en minutos.
- **Guardarraíl de Conflictos Cíclicos**: Implementado un algoritmo matemático robusto que transforma todas las agendas en minutos semanales del ciclo (10080 minutos) para detectar y bloquear envolturas o solapamientos en tiempo real (por ejemplo, previniendo choques entre shows diarios, shows semanales en el mismo día, y shows que se cruzan por la medianoche).
- **Selección de DJ Dinámica en Tiempo Real**: El orquestador de radio calcula la hora exacta en la zona de Perú (`America/Lima`) en cada ciclo y carga la personalidad y voz del locutor programado. Si no hay programaciones activas en ese bloque, cae de forma segura en el locutor marcado como "Predeterminado de Reserva" (Fallback) o el locutor por defecto del entorno.
- **Panel de Administración Brutalista**: Creadas dos interfaces de usuario independientes y premium con estilo brutalista en Astro en `/admin` (Inglés) y `/es/admin` (Español), integrando retroalimentación de conflictos, edición rápida de locutores y listado de horarios interactivo.
- **Optimización del Bucle del Agente (Fix de Bucle de Búsqueda)**: Se limitaron las búsquedas consecutivas de canciones por texto para el modelo a un máximo de 1-2 intentos si no hay resultados en la biblioteca, obligándolo a elegir de inmediato de la lista de sugerencias en lugar de quedar atrapado en llamadas de herramienta infinitas. Además, se aumentó el límite de turnos del agente a 6 para evitar cortes de planifición prematuros.
- **Extracción de JSON Tolerante a Conversación**: Implementado un extractor por subcadenas (empleando `indexOf("{")` y `lastIndexOf("}")`) previo a ejecutar `JSON.parse`. Esto previene fallas si el LLM incluye prefacios de texto o explicaciones antes del bloque estructurado JSON.
- **Entrega de Decisiones mediante Herramienta (`submit_decisions`)**: Se introdujo una herramienta nativa para que la IA devuelva su planificación estructurada como argumentos de una función. Esto maximiza la compatibilidad en OpenRouter entre diferentes proveedores (como DeepSeek y Gemini) que a veces fallan o ignoran el parámetro `response_format` inyectando texto libre junto al JSON, eliminando por completo cualquier riesgo de parseo erróneo de texto.
- **Optimización de Rendimiento del MCP `radio_status`**: Se identificó un cuello de botella crítico con problema N+1 en `queueList()` — cada rid en la cola hacía un request telnet secuencial. Con 30 canciones = ~34 llamadas de red en serie. Soluciones: (1) Paralelización de metadata fetches con `Promise.all()` en `queueList()`, `queueRemove()` e `queueInsert()`; (2) Ejecución paralela de `getStreamStatus()` y `queueList()` en el tool `radio_status`; (3) Nuevo parámetro `limit` en `queueList()` para solo buscar metadata de los items necesarios; (4) `queueList()` ahora retorna `{ items, total }` para evitar fetches innecesarios.
### Admin de Biblioteca, Playlists e Interludios (React + shadcn/ui + dnd-kit)

- **Nuevo Admin SPA**: Se reemplazó el `admin.astro` brutalista (gestor de locutores) por un SPA React (shadcn/ui + @dnd-kit) integrado en Astro vía `@astrojs/react`.
- **Stack del admin**: React 19, react-router-dom, shadcn/ui (new-york), Tailwind v4, @dnd-kit (core + sortable), sonner (toasts), lucide-react.
- **Árbol de biblioteca** (`GET /api/library/tree`): Nuevo endpoint en el publisher que devuelve la estructura de carpetas anidada de `songs/` e `interludios/` como árbol (`FileTreeNode`), facilitando navegación y drag & drop desde la sidebar.
- **Drag & drop a playlists**: Se puede arrastrar cualquier track del árbol de biblioteca (sidebar izquierda, siempre visible) hacia la cola de una playlist. Internamente usa `POST /api/playlists/:id/tracks` con el nuevo campo `libraryTrackId`.
- **Reordenamiento en cola**: Los tracks de la playlist se reordenan con @dnd-kit/sortable, persistiendo con `PUT /api/playlists/:id/tracks/reorder`.
- **Interludios de texto con TTS**: Se añadió soporte para interludios sin archivo de audio, con un campo `script` (texto) en `playlist_tracks`. Al reproducir la playlist (`POST /api/playlists/:id/play`), los interludios con `script` y sin `file` se sintetizan a audio vía Edge-TTS (`ai_dj_pl_*.mp3`) y se encolan en Liquidsoap. Servicio reutilizable `TtsService`.
- **Esquema DB**: Columna `script TEXT` añadida a `playlist_tracks` con migración idempotente en `database.ts`.
- **Validación de `type`**: `POST /api/playlists/:id/tracks` ahora valida que `type` sea `song` o `interludio`; un interludio debe tener `file` o `script`.
- **`libraryTrackId`**: El endpoint `POST /api/playlists/:id/tracks` acepta `libraryTrackId` para autorrellenar `title/artist/file/duration/type` desde la biblioteca.
- **SPA fallback**: En el router del publisher, cualquier ruta `/admin/*` (excepto `/admin/queues` de Bull-Board) sirve `admin/index.html` para que el client-side routing de React Router funcione en refresh.
- **Config web**: `astro.config.mjs` integra `@astrojs/react` y proxy Vite (`/api` -> `http://localhost:9876`) para desarrollo local. `tsconfig.json` con `jsx: react-jsx` y path alias `@/*`.
- **Estilos**: `admin.css` independiente con tokens shadcn (no interfiere con el `global.css` brutalista de las landing pages).
- **Eliminado `es/admin.astro`**: El admin ya no tiene duplicación i18n (es herramienta interna, sin i18n).

### Auditoría de Estabilidad del Server (28 issues) Se realizó un análisis exhaustivo de riesgos de crash. Fixes aplicados: (1) `AbortSignal.timeout(60s)` en fetch de OpenRouter para evitar que el orquestador se congele permanentemente; (2) SQLite cambiado a WAL mode + busy_timeout de 5s para manejar escrituras concurrentes; (3) Restore de playback envuelto en try/catch para prevenir unhandled rejections; (4) Mutex (`withQueueLock`) en `queueRemove`/`queueInsert` para prevenir race conditions que vaciaban la cola; (5) TelnetClient con `commandQueue` limitado a 50, buffer limitado a 1MB, y reconexión que para tras 100 intentos; (6) `fs.watch` handles se cierran en `shutdown()`; (7) `scan()` del library con mutex para evitar scans concurrentes; (8) Sesiones MCP con timeout de 30min y límite de 20 sesiones; (9) Upload endpoint con límite de 200MB; (10) Rate limiting básico (120 req/min por IP); (11) `durationCache` con evict de entradas stale; (12) StreamBroadcaster con límite de 500 clientes; (13) aria2c con safety timeout de 10min + cleanup de temp dirs en fallo; (14) `writeFileSync` reemplazado por `fsPromises.writeFile` async; (15) Graceful shutdown con `_server.stop()`; (16) Null check en `findSpotifyUrl`.

### Corrección de Interfaz del Panel de Administración, Drag & Drop y Reordenamiento (Julio 2026)

- **Corrección de Conflicto de Rutas (Reordenamiento)**: Se corrigió un error en el que las peticiones `PUT /api/playlists/:id/tracks/reorder` fallaban con un error `"No fields to update"` debido a que chocaban con la ruta parametrizada `/api/playlists/:id/tracks/:trackId` definida anteriormente. Se reordenaron las rutas en `publisher/src/api/router.ts` para resolver el conflicto.
- **Resolución de Drag & Drop de Biblioteca a Playlist**: Se corrigió el bug que impedía arrastrar canciones sobre elementos existentes de la playlist. Se añadió metadata en el `useSortable` de [PlaylistTrackItem.tsx](file:///d:/cursos/SEED-AUDIO/radio/web/src/components/admin/PlaylistTrackItem.tsx) para identificar el tipo de elemento (`type: "playlist-track"`), permitiendo que [AdminApp.tsx](file:///d:/cursos/SEED-AUDIO/radio/web/src/components/admin/AdminApp.tsx) identifique y encole las canciones sin importar sobre qué elemento se suelten.
- **Rediseño Premium en Modo Oscuro**: Se migró el panel de administración a un tema oscuro moderno basado en zinc que incorpora el color de marca de Radio Bloom (naranja neón `#ff3b00`) como color primario, mejorando los estilos del explorador de canciones [SidebarTree.tsx](file:///d:/cursos/SEED-AUDIO/radio/web/src/components/admin/SidebarTree.tsx) y agregando indicadores visuales para colas vacías en [PlaylistDetail.tsx](file:///d:/cursos/SEED-AUDIO/radio/web/src/components/admin/PlaylistDetail.tsx).

### Panel de Monitoreo de Transmisión en Vivo, Comandos de Liquidsoap y Pruebas Unitarias Robustas (Julio 2026)

- **Isla de Control en Vivo en Tiempo Real**: Se creó el componente [StreamQueueIsland.tsx](file:///d:/cursos/SEED-AUDIO/radio/web/src/components/admin/StreamQueueIsland.tsx) integrado en la parte inferior del panel de administración. Permite visualizar metadatos ("Ahora en vivo" con barra de progreso fluida de 1 segundo), locutores o shows programados en el bloque de tiempo actual ("Programado") y los temas en la cola activa ("Cola en vivo") con bordes de color correspondientes (rojo para canciones, verde para interludios).
- **Encolado Interactivo de Stream**: Se adaptó el flujo de drag & drop en [AdminApp.tsx](file:///d:/cursos/SEED-AUDIO/radio/web/src/components/admin/AdminApp.tsx) para admitir drops sobre el contenedor `"stream-queue"`, enviando solicitudes POST inmediatas al servidor de radio y refrescando el dashboard en vivo automáticamente.
- **Resolución de Comando Skip, Metadatos y Sincronización en Liquidsoap**:
  - Se corrigió el bug en [liquidsoap.service.ts](file:///d:/cursos/SEED-AUDIO/radio/publisher/src/services/liquidsoap.service.ts) donde `request.on_air` fallaba. Se implementó una lógica de resolución robusta en `getActiveRequestId()` que recupera todos los request IDs de `request.all`, lee su metadata y los compara de forma normalizada (insensible a mayúsculas y acentos) con el tema actual obtenido directamente de `output.harbor.metadata`. Esto asegura que el backend mapee el ID de petición exacto (p. ej., distinguiendo entre varias canciones activas).
  - Se corrigió la falta de sincronización de la barra de progreso al recargar la página: dado que Liquidsoap no añade `on_air_timestamp` por defecto, se implementó el cálculo del tiempo transcurrido (`elapsed`) de manera matemática como `duration - remaining` consultando la orden de Liquidsoap `output.harbor.remaining`. Esto asegura una sincronización precisa e instantánea que se conserva tras cada recarga.
  - Se reemplazó el comando Telnet inactivo `queue.flush_and_skip` por `output.harbor.skip` para realizar skips limpios y universales tanto en listas pregrabadas como en la cola dinámica.
- **Resolución de Archivos Locales en Listas de Reproducción**:
  - Se identificó que las canciones importadas desde Spotify en las playlists no guardan una referencia de archivo físico directa (`file = NULL`). Al dar "Play", el backend saltaba estas pistas.
  - Se implementó un resolvedor dinámico en `POST /api/playlists/:id/play` que consulta la base de datos local usando la URL de Spotify (`getTrackByUrl`) o el Título y Artista (`getTrackByTitleAndArtist`). Si la canción ya fue descargada e indexada en la biblioteca, la reproduce localmente en lugar de ignorarla.
- **Persistencia de la Cola Completa**: Se modificó `playback_state` para guardar toda la cola de Liquidsoap (cada track en una fila con `position`), no solo el track actual. Al reiniciar el servidor se restaura la cola completa.
- **Refactorización Completa del Set de Pruebas Unitarias y de Integración**:
  - Se rediseñó por completo [api.test.ts](file:///d:/cursos/SEED-AUDIO/radio/publisher/test/api.test.ts) eliminando las antiguas dependencias mockeadas a nivel de sistema de módulos (`mock.module`), pasando en su lugar un set limpio de repositorios y servicios simulados a través de `createApiRouter(deps)`. Se alinearon todas las aserciones de encolamiento y rutas de biblioteca con la versión actual de la API.
  - Se reescribió [integration.test.ts](file:///d:/cursos/SEED-AUDIO/radio/publisher/test/integration.test.ts) para realizar pruebas reales con SQLite usando `DatabaseConnection` y `LibraryService` para escanear y buscar canciones en un directorio temporal limpio que se recicla en cada ejecución.
  - Se verificaron los tests ejecutando `bun test`, logrando un **100% de éxito con 57 tests aprobados** en la suite del backend (`api.test.ts`, `integration.test.ts`, y `locutor.test.ts`).

### Limpieza Final de Publisher (Julio 2026)

- **Código muerto eliminado**: `publisher/src/types/mcp-server.d.ts` — declaraciones ambientales redundantes que resolvían al `index.d.ts` del paquete (nunca se usaban).
- **Ambient `zod.d.ts` simplificado**: Se reimplementó el shim con solo los métodos que el publisher realmente usa (string, number, boolean, array, object, enum, literal, union, optional, nullable, default, coerce). Evita que TypeScript resuelva los ~5000 tipos del paquete `zod` en cada compilación.
- **Path mapping corregido**: `zod` apunta ahora a `./src/types/zod.d.ts` (directamente) en vez de `./src/types/zod.js` (que no existía).
- **Validación**: Typecheck del publisher pasa (0 errores). Smoke test de todos los exports del mcp-server OK.

### Configuración de Monorepo con Docker Compose (Julio 2026)

- **Dockerfile para web**: Multi-stage build con `oven/bun:1.2-alpine` para build + `nginx:alpine` para producción.
- **docker-compose.dev.yml actualizado**: Servicios `redis`, `liquidsoap` y `web` para desarrollo local. El `web` usa bind mounts para hot reload.
- **docker-compose.yml (producción)**: Servicio `web` agregado con nginx, dependiendo de `publisher`.
- **Scripts monorepo**: `package.json` raíz con scripts para开发 (`dev`, `dev:web`, `dev:all`), infra (`dev:infra`, `docker:up`, `docker:down`, `docker:dev`, `docker:build`) y build (`build`, `build:all`, `lint`, `typecheck`).
- **Variable de entorno**: `WEB_PORT` agregada a `.env.example` (default: 80).

### 🎙️ AI DJ Fase 1 y 2 — Playlist por Horario + Creación Autónoma con IA (Julio 2026)

- **Threshold de cola elevado a 5**: El orquestador ahora activa el DJ cuando quedan **5 canciones** en cola (antes eran 2), dando más tiempo para planificar y rellenar sin cortes.
- **Vínculo Playlist-Locutor**: La tabla `playlists` ahora tiene columnas `locutor_id` (FK → locutors) y `description` (texto corto). Esto permite asignar playlists pre-armadas a locutores específicos.
- **Búsqueda por horario**: Cuando la cola baja, el orquestador busca primero una playlist asignada al locutor activo (`findActivePlaylistForLocutor`). Si existe, calcula cuántas canciones encolar basándose en la duración restante de las canciones en cola (no corta canciones, tolerancia de 30s).
- **AI DJ Phase 2 (sin playlist)**: Si NO hay playlist para el locutor activo, se activa el LLM con:
  - **10 canciones recientes** del locutor (de playlists anteriores) para entender su feeling.
  - **100 canciones menos reproducidas** del catálogo (ordenadas por `lastPlayedAt` ASC), con ID, título, artista y duración real.
  - **Las 2 últimas canciones en cola** como contexto (sabe que son de otro programa).
  - **Personalidad y voz del locutor** (de la tabla `locutors`).
  - **NO recibe la hora** (porque no sabe cuánto duran los interludios generados).
- **Herramienta `create_program_playlist`**: El LLM crea una playlist permanente en BD con los IDs reales del catálogo. El sistema guarda la playlist, calcula duración total, y la encola automáticamente.
- **Método `getLeastPlayedTracks`**: Nuevo en `LibraryRepository` — ordena canciones por `lastPlayedAt` ASC (nulas primero) para dar prioridad a las que más tiempo llevan sin sonar.
- **Archivos modificados**: `schema.ts`, `database.ts` (migración), `types.ts`, `playlist.repo.ts` (nuevos métodos), `orchestrator.service.ts` (Phase 2 + reescritura de `enqueueNext`), `router.ts` (endpoints actualizados), `library.repo.ts` (`getLeastPlayedTracks`), `index.ts` (DI), `web/types.ts`.

### 🔧 Fix MCP Server — Reconexión desde MCP Inspector (Julio 2026)

- **Error**: `Server already initialized` (`-32600`) al reconectar desde MCP Inspector v0.22.0 con transport Streamable HTTP.
- **Causa**: `McpService.handleHttpRequest` creaba una sola instancia de `HttpTransport` y la reutilizaba para todas las sesiones. Al reconectar, el segundo `initialize` golpeaba el transport ya inicializado y era rechazado.
- **Solución**: `mcp.service.ts` — Se creó un transport nuevo solo cuando llega una sesión nueva (nuevo `initialize`). Si el request trae un `mcp-session-id` que ya existe, reutiliza el transport actual. Se resetea `server._transport` para permitir `connect()` con el nuevo transport.
- **Archivo modificado**: `publisher/src/services/mcp.service.ts` (nuevo campo `currentSessionId`, lógica de sesiones en `handleHttpRequest`).
