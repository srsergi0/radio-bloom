# Radio Bloom

Internet radio station powered by Icecast, Bun, spotDL, and Cloudflare Tunnel.

## Architecture

```
┌─────────────┐   ┌──────────────┐   ┌──────────────┐
│  Icecast2   │◄──┤  Publisher   │◄──┤  Web UI      │
│  (Docker)   │   │  (Bun+FFmpeg)│   │  (Astro)     │
│  :8000      │   │  :3000       │   │  :3001       │
└─────────────┘   └──────┬───────┘   └──────────────┘
                         │
                   spotDL (Docker)
                   descarga de Spotify
                         │
                         ▼
                   music/songs/ (local)
```

## Quick Start (Local)

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env with your passwords
```

### 2. Create music directories

```bash
mkdir -p music/songs
mkdir -p music/interludios
```

### 3. Create the shared Docker network

```bash
docker network create radio-net
```

### 4. Start everything

```bash
docker compose -f docker-compose.engine.yml up -d
docker compose -f docker-compose.publisher.yml up -d
```

### 5. Open the control panel

```bash
cd web
bun install
bun run dev
```

Open http://localhost:3001

### 6. Add music

- Pega un link de Spotify en el input del sidebar
- Click descargar (o presiona Enter)
- spotDL descarga el MP3 en background
- La canción aparece en la biblioteca
- Arrástrala al timeline

### 7. Configure Cloudflare Tunnel

Tu tunnel ya instalado debe apuntar a `localhost:8000`:

```bash
# En la config del tunnel:
ingress:
  - hostname: radio.tudominio.com
    service: http://localhost:8000
```

Stream URL: `https://radio.tudominio.com/radiobloom.mp3`

## Despliegue en Coolify (Zero-Downtime)

El proyecto incluye dos Docker Compose separados para Coolify, de modo que los cambios en el código (publisher, web) **no reinician el motor de streaming** (Liquidsoap).

### Problema

Coolify redeployea todos los contenedores de un recurso en cada push. Si todo va en un solo `docker-compose.yml`, un cambio en la web tira la radio.

### Solucion

Se divide en 2 stacks independientes que comparten una red Docker externa:

| Stack | Compose | Servicios | Auto Deploy |
|-------|---------|-----------|-------------|
| **radio-engine** | `docker-compose.engine.yml` | liquidsoap, ftp | ❌ Manual |
| **radio-publisher** | `docker-compose.publisher.yml` | publisher | ✅ ON |

Los contenedores usan `container_name` fijo (`radio-liquidsoap`, `radio-publisher`, `radio-ftp`) para que Docker DNS los resuelva correctamente entre stacks mediante la red externa `radio-net`.

### Configuracion en Coolify

#### 1. Crear la red Docker (una sola vez en el servidor)

```bash
docker network create radio-net
```

#### 2. Crear los dos resources en Coolify

En un mismo proyecto de Coolify, crear **2 resources** apuntando al mismo repositorio Git:

**Resource 1 — radio-engine:**
- Build Pack: Docker Compose
- Docker Compose Location: `docker-compose.engine.yml`
- Auto Deploy: **OFF** (desactivado)
- Base Directory: `/`

**Resource 2 — radio-publisher:**
- Build Pack: Docker Compose
- Docker Compose Location: `docker-compose.publisher.yml`
- Auto Deploy: **ON** (activado)
- Base Directory: `/`

#### 3. Variables de entorno

Configurar las variables del `.env` en ambos resources de Coolify:

**radio-engine:**
```
FTP_PUBLIC_HOST=<tu-dominio>
FTP_PORT=21
FTP_PASSIVE_MIN=30000
FTP_PASSIVE_MAX=30009
FTP_USER_NAME=radio
FTP_USER_PASS=<tu-password>
FTP_USER_HOME=/home/radio
FTP_UMASK=133
```

**radio-publisher:**
```
API_PORT=9876
LIQUIDSOAP_HOST=radio-liquidsoap
LIQUIDSOAP_TELNET_PORT=1234
LIQUIDSOAP_HARBOUR_PORT=8000
PUBLISHER_PORT=3000
SPOTIFY_CLIENT_ID=<tu-client-id>
SPOTIFY_CLIENT_SECRET=<tu-client-secret>
```

> **Importante:** `LIQUIDSOAP_HOST` debe ser `radio-liquidsoap` (el `container_name`), no `liquidsoap`. Los `SPOTIFY_CLIENT_ID` y `SPOTIFY_CLIENT_SECRET` se obtienen de [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).

#### 4. Despliegue inicial

1. Deployear **radio-engine** primero (crea liquidsoap y ftp)
2. Deployear **radio-publisher** despues (conecta con engine via `radio-net`)

### Flujo de trabajo

| Que cambia | Que pasa |
|------------|----------|
| `web/`, `publisher/` | radio-publisher se redeployea solo. La radio **no se cae**. |
| `liquidsoap/` | Entras a Coolify y deployeas radio-engine manualmente. |
| Variables de entorno | Actualizar variables en ambos resources de Coolify. |

### Local (sin Coolify)

```bash
docker network create radio-net          # una vez
docker compose -f docker-compose.engine.yml up -d
docker compose -f docker-compose.publisher.yml up -d
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/timeline | Get current timeline |
| POST | /api/timeline | Save new timeline |
| PUT | /api/timeline/reorder | Reorder tracks |
| POST | /api/timeline/add | Add track |
| DELETE | /api/timeline/:id | Remove track |
| GET | /api/library | List local music files |
| POST | /api/download | Download from Spotify URL |
| GET | /api/download/:id | Check download status |
| GET | /api/status | Stream status |
| POST | /api/control/play | Start streaming |
| POST | /api/control/pause | Stop streaming |
| POST | /api/control/skip | Skip to next |
| WS | /ws | Real-time events |

## Structure

```
radio/
├── docker-compose.engine.yml        # liquidsoap + enricher + ftp
├── docker-compose.publisher.yml     # publisher solo
├── .env
├── icecast/
│   └── icecast.xml
├── music/
│   ├── songs/          # MP3s descargados de Spotify
│   └── interludios/    # Interludios generados
├── publisher/
│   ├── src/
│   │   ├── index.ts
│   │   ├── api.ts
│   │   ├── library.ts
│   │   ├── playlist.ts
│   │   ├── streamer.ts
│   │   ├── metadata.ts
│   │   ├── spotdl.ts
│   │   └── websocket.ts
│   └── Dockerfile
├── web/
│   ├── src/
│   │   ├── pages/index.astro
│   │   └── layouts/Layout.astro
│   ├── public/scripts/
│   │   ├── timeline.js
│   │   ├── player.js
│   │   └── websocket.js
│   └── astro.config.mjs
```

## How it works

1. **Pegas un link de Spotify** → spotDL descarga el MP3
2. **Arrastras al timeline** → se guarda en `timeline.json`
3. **Publisher spawna FFmpeg** → lee los MP3s locales → stream a Icecast
4. **Icecast sirve el stream** → vía HTTP en `:8000`
5. **Tunnel expone HTTPS** → `radio.tudominio.com`
6. **Radio Garden recibe** → `https://radio.tudominio.com/radiobloom.mp3`

## MCP (Model Context Protocol)

Este proyecto incluye un servidor MCP para que agentes de IA (como Claude Desktop, Cursor o VS Code) puedan controlar la radio directamente.

### Herramientas disponibles
* `radio_status`: Obtiene el estado actual del stream (reproducción, cola, stats).
* `radio_search`: Busca canciones o interludios en la biblioteca por título/artista/álbum.
* `radio_queue_list`: Lista los elementos actualmente en la cola de reproducción.
* `radio_queue_add`: Añade un archivo al final de la cola.
* `radio_queue_insert`: Inserta un archivo en una posición específica de la cola.
* `radio_queue_remove`: Elimina un elemento de la cola por su posición.
* `radio_queue_clear`: Vacía la cola completa.
* `radio_play_now`: Limpia la cola, encola el archivo y salta a él inmediatamente.
* `radio_skip`: Salta la canción actual en reproducción.
* `radio_library_stats`: Obtiene el número total de temas e interludios, duración y tamaño.
* `radio_list_songs` / `radio_list_interludios`: Lista canciones o interludios paginados.
* `radio_playlist_list` / `radio_playlist_get`: Lista y obtiene las playlists guardadas en la base de datos.

### Configuración en Clientes de IA (como Claude Desktop)

Puedes conectar tu agente al servidor MCP de dos formas:

#### Opción 1: Conexión Remota (Producción)
Configura tu cliente para conectarse al transporte HTTP/SSE de producción:

```json
{
  "mcpServers": {
    "radio-bloom-prod": {
      "sse": {
        "url": "http://<IP_O_DOMINIO_DE_TU_SERVIDOR>:<PUERTO>/mcp"
      }
    }
  }
}
```

#### Opción 2: Conexión Local (STDIO)
Si estás desarrollando localmente y deseas que el cliente levante el servidor directamente como subproceso:

```json
{
  "mcpServers": {
    "radio-bloom-local": {
      "command": "bun",
      "args": ["run", "src/mcp-entry.ts"],
      "cwd": "C:/tu/ruta/a/radio/publisher",
      "env": {
        "DATA_DIR": "C:/tu/ruta/a/radio/publisher/data",
        "MUSIC_DIR": "C:/tu/ruta/a/radio/music"
      }
    }
  }
}
```
> [!NOTE]
> Asegúrate de reemplazar `C:/tu/ruta/a/` por las rutas absolutas correspondientes en tu sistema.

