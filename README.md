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

## Quick Start

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

### 3. Start everything

```bash
docker compose up -d
```

### 4. Open the control panel

```bash
cd web
bun install
bun run dev
```

Open http://localhost:3001

### 5. Add music

- Pega un link de Spotify en el input del sidebar
- Click descargar (o presiona Enter)
- spotDL descarga el MP3 en background
- La canción aparece en la biblioteca
- Arrástrala al timeline

### 6. Configure Cloudflare Tunnel

Tu tunnel ya instalado debe apuntar a `localhost:8000`:

```bash
# En la config del tunnel:
ingress:
  - hostname: radio.tudominio.com
    service: http://localhost:8000
```

Stream URL: `https://radio.tudominio.com/radiobloom.mp3`

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
├── docker-compose.yml
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
└── watchdog/
    └── src/index.ts
```

## How it works

1. **Pegas un link de Spotify** → spotDL descarga el MP3
2. **Arrastras al timeline** → se guarda en `timeline.json`
3. **Publisher spawna FFmpeg** → lee los MP3s locales → stream a Icecast
4. **Icecast sirve el stream** → vía HTTP en `:8000`
5. **Tunnel expone HTTPS** → `radio.tudominio.com`
6. **Radio Garden recibe** → `https://radio.tudominio.com/radiobloom.mp3`
