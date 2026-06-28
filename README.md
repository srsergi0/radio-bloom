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
docker compose up -d
```

El archivo `docker-compose.override.yml` se aplica automáticamente y mapea tu carpeta `./music/` local a los contenedores (bind mounts).

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
docker compose down
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

### 2. Crear volumes

```bash
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
docker compose up -d
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
        proxy_pass http://127.0.0.1:9876;
        proxy_set_header Host $host;
    }
}
```

> **Importante**: `proxy_buffering off;` es OBLIGATORIO para el stream de audio en vivo.

---

## Despliegue en Coolify

Coolify usa el `docker-compose.yml` unificado. Todos los servicios comparten la misma red automáticamente.

### 1. Preparar el servidor (una sola vez)

```bash
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

### 3. Crear el resource en Coolify

- Build Pack: Docker Compose
- Compose Location: `docker-compose.yml`
- Auto Deploy: **ON**
- Base Directory: `/`

### 4. Variables de entorno en Coolify

```
API_PORT=9876
LIQUIDSOAP_HOST=liquidsoap
LIQUIDSOAP_TELNET_PORT=1234
LIQUIDSOAP_HARBOUR_PORT=8000
PUBLISHER_PORT=3000
SPOTIFY_CLIENT_ID=tu-client-id
SPOTIFY_CLIENT_SECRET=tu-client-secret
FTP_PUBLIC_HOST=tudominio.com
FTP_PORT=21
FTP_PASSIVE_MIN=30000
FTP_PASSIVE_MAX=30009
FTP_USER_NAME=radio
FTP_USER_PASS=tu-password
FTP_USER_HOME=/home/radio
FTP_UMASK=133
```

> `LIQUIDSOAP_HOST` debe ser `liquidsoap` (el nombre del servicio), no `radio-liquidsoap`.

### 5. Orden de deploy

Solo hay un stack. Coolify redeployea todos los contenedores en cada push. El estado de reproducción se guarda en SQLite y se restaura automáticamente.

### Flujo de trabajo

| Que cambia | Que pasa |
|------------|----------|
| `publisher/`, `web/` | Todo se redeployea. **La radio se cae ~5s y retoma donde quedó**. |
| `liquidsoap/radio.liq` | Deploy manual o auto-deploy. |
| `downloader/` | Se rebuilda con el publisher. |
| `ftp/` | Se rebuilda con el mismo stack. |

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

---

## Estructura

```
radio/
├── docker-compose.yml               # Unificado (producción / Coolify)
├── docker-compose.override.yml      # Local: bind mounts + ports
├── .env
├── liquidsoap/
│   └── radio.liq                    # Config de Liquidsoap
├── ftp/
│   ├── Dockerfile                   # Custom entrypoint (fix permisos)
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

- **Producción**: `docker-compose.yml` — todos los servicios en un solo stack, misma red Docker automática.
- **Desarrollo local**: `docker compose up` usa automáticamente `docker-compose.override.yml` con bind mounts.
- **FTP**: Sube canciones a `music/songs/` vía FTP. El entrypoint del contenedor arregla permisos automáticamente.
- **Spotify**: El publisher descarga directamente de Spotify usando Client Credentials API + SpotiFLAC.
- **Liquidsoap**: Lee `/music/songs/` y reinicia la playlist cada 30 segundos. Soporta mp3, flac, m4a, ogg.
- **Persistencia**: El estado de reproducción se guarda cada 15s en SQLite. Al reiniciar, retoma la canción donde quedó.
- **Puertos**: Liquidsoap escucha en 8000 (harbor). En Coolify NO se expone al host — el publisher lo alcanza por Docker network.
