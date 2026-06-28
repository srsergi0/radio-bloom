# Radio Bloom

Internet radio station powered by Liquidsoap, Bun, and Spotify.

## Architecture

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────┐
│   liquidsoap     │◄──┤    publisher     │◄──┤  Web UI  │
│  (streaming)     │   │  (Bun+FFmpeg)    │   │ (Astro)  │
│  harbor :8000    │   │  API :3000       │   │          │
└────────┬─────────┘   └────────┬─────────┘   └──────────┘
         │                      │
    ┌────┴────┐          ┌──────┴──────┐
    │   FTP   │          │  downloader │
    │ :21     │          │  (SpotiFLAC)│
    └─────────┘          └─────────────┘
         │
    music/songs/  ←── canciones subidas por FTP
```

Los contenedores se comunican entre sí por Docker DNS usando `container_name` fijo en la red `radio-net`.

---

## Desarrollo Local

### 1. Configurar entorno

```bash
cp .env.example .env
# Editar .env con tus credenciales de Spotify y passwords de FTP
```

### 2. Crear carpetas de música

```bash
mkdir -p music/songs music/interludios
```

### 3. Arrancar

```bash
docker network create radio-net 2>/dev/null

docker compose -f docker-compose.engine.yml -f docker-compose.engine.override.yml up -d
docker compose -f docker-compose.publisher.yml -f docker-compose.publisher.override.yml up -d
```

Los archivos `.override.yml` mapean tu carpeta `./music/` local a los contenedores (bind mounts), así que al agregar canciones por FTP o Spotify aparecen directamente en tu disco.

### 4. Abrir la web

```bash
cd web && bun install && bun run dev
```

Abrir http://localhost:3001

### 5. Verificar

- Stream: http://localhost:8000/radiobloom.mp3
- API: http://localhost:9876/api/status
- Skip: http://localhost:9876/api/stream/skip

### Detener todo

```bash
docker compose -f docker-compose.engine.yml -f docker-compose.engine.override.yml down
docker compose -f docker-compose.publisher.yml -f docker-compose.publisher.override.yml down
```

---

## Despliegue en Servidor (sin Coolify)

Si quieres correr todo en un VPS sin Coolify:

### 1. Clonar y configurar

```bash
git clone https://github.com/srsergi0/radio-bloom.git
cd radio-bloom
cp .env.example .env
# Editar .env con credenciales reales
```

### 2. Crear red y volumes

```bash
docker network create radio-net
docker volume create radio-music
docker volume create radio-interludios
docker volume create radio-publisher-data
```

### 3. Copiar música al volume

```bash
docker run --rm \
  -v radio-music:/target \
  -v $(pwd)/music/songs:/source \
  alpine cp -r /source/. /target/
```

### 4. Arrancar

```bash
docker compose -f docker-compose.engine.yml up -d
docker compose -f docker-compose.publisher.yml up -d
```

### 5. Exponer stream

El publisher escucha en el puerto definido por `API_PORT` (default 9876). Configura nginx o tu proxy para routear a ese puerto:

```nginx
# /etc/nginx/sites-available/radio
server {
    listen 443 ssl;
    server_name radio.tudominio.com;

    location /radiobloom.mp3 {
        proxy_pass http://127.0.0.1:9876;
        proxy_set_header Host $host;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
```

---

## Despliegue en Coolify (Zero-Downtime)

Coolify redeployea todos los contenedores de un recurso en cada push. Para que un cambio en la web **no reinicie el motor de streaming**, se usan 2 stacks separados.

### Concepto

| Stack | Compose | Servicios | Auto Deploy |
|-------|---------|-----------|-------------|
| **radio-engine** | `docker-compose.engine.yml` | liquidsoap, ftp | Manual |
| **radio-publisher** | `docker-compose.publisher.yml` | publisher, downloader | ON |

Ambos stacks comparten la red Docker externa `radio-net` para comunicarse por DNS.

### 1. Preparar el servidor (una sola vez)

```bash
# Crear red compartida
docker network create radio-net

# Crear volumes
docker volume create radio-music
docker volume create radio-interludios
docker volume create radio-publisher-data
```

### 2. Copiar config de liquidsoap al servidor

```bash
scp liquidsoap/radio.liq root@TU_SERVIDOR:/tmp/radio.liq
docker run --rm -v /data/radio/config:/config -v /tmp:/tmp alpine sh -c \
  "mkdir -p /config && cp /tmp/radio.liq /config/radio.liq"
```

### 3. Crear los 2 resources en Coolify

En el mismo proyecto de Coolify, crear 2 resources apuntando al mismo repo:

**Resource 1 — radio-engine:**
- Build Pack: Docker Compose
- Compose Location: `docker-compose.engine.yml`
- Auto Deploy: **OFF**
- Base Directory: `/`

**Resource 2 — radio-publisher:**
- Build Pack: Docker Compose
- Compose Location: `docker-compose.publisher.yml`
- Auto Deploy: **ON**
- Base Directory: `/`

### 4. Variables de entorno en Coolify

**radio-engine:**
```
FTP_PUBLIC_HOST=tudominio.com
FTP_PORT=21
FTP_PASSIVE_MIN=30000
FTP_PASSIVE_MAX=30009
FTP_USER_NAME=radio
FTP_USER_PASS=tu-password
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
SPOTIFY_CLIENT_ID=tu-client-id
SPOTIFY_CLIENT_SECRET=tu-client-secret
DOWNLOADER_URL=http://radio-downloader:4002
```

> `LIQUIDSOAP_HOST` debe ser `radio-liquidsoap` (el `container_name`), no `liquidsoap`.

### 5. Orden de deploy

1. Deployear **radio-engine** primero (crea liquidsoap y ftp)
2. Deployear **radio-publisher** después (se conecta al engine via `radio-net`)

### Flujo de trabajo

| Que cambia | Que pasa |
|------------|----------|
| `publisher/`, `web/` | radio-publisher se redeployea solo. **La radio no se cae**. |
| `liquidsoap/radio.liq` | Deploy manual de radio-engine en Coolify. |
| `downloader/` | Se rebuilda con radio-publisher. |
| `ftp/` | Se rebuilda con radio-engine (deploy manual). |

---

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/status | Estado del stream |
| GET | /api/timeline | Obtener timeline |
| POST | /api/timeline | Guardar timeline |
| PUT | /api/timeline/reorder | Reordenar tracks |
| POST | /api/timeline/add | Agregar track |
| DELETE | /api/timeline/:id | Eliminar track |
| GET | /api/library | Listar música local |
| POST | /api/download | Descargar de Spotify |
| GET | /api/download/:id | Estado de descarga |
| GET | /api/stream/skip | Saltar canción actual |
| POST | /api/stream/queue | Encolar canción |
| GET | /api/stream/queue | Ver cola |
| DELETE | /api/stream/queue | Vaciar cola |
| WS | /ws | Eventos en tiempo real |

---

## Estructura

```
radio/
├── docker-compose.engine.yml          # Engine (liquidsoap + ftp)
├── docker-compose.engine.override.yml # Local: bind mounts + port 8000
├── docker-compose.publisher.yml       # Publisher + downloader
├── docker-compose.publisher.override.yml  # Local: bind mounts
├── .env
├── liquidsoap/
│   └── radio.liq                      # Config de Liquidsoap
├── ftp/
│   ├── Dockerfile                     # Custom entrypoint (fix permisos)
│   └── entrypoint.sh
├── publisher/
│   ├── src/
│   │   ├── index.ts
│   │   ├── api/router.ts
│   │   ├── services/
│   │   ├── repositories/
│   │   └── infrastructure/
│   └── Dockerfile
├── downloader/
│   ├── server.py
│   └── Dockerfile
├── web/
│   └── src/
│       ├── pages/index.astro
│       └── components/Player.astro
└── music/
    ├── songs/          # Canciones (FTP o Spotify)
    └── interludios/    # Interludios
```

---

## Notas

- **FTP**: Sube canciones a `music/songs/` vía FTP. El entrypoint del contenedor arregla permisos automáticamente.
- **Spotify**: El publisher descarga directamente de Spotify usando Client Credentials API + SpotiFLAC.
- **Liquidsoap**: Lee `/music/songs/` y reinicia la playlist cada 30 segundos. Soporta mp3, flac, m4a, ogg.
- **Puertos**: Liquidsoap escucha en 8000 (harbor). En Coolify NO se expone al host — el publisher lo alcanza por Docker network. En local, el override lo mapea.
