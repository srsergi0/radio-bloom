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

## Despliegue en Servidor

### 1. Clonar y configurar

```bash
git clone https://github.com/srsergi0/radio-bloom.git
cd radio-bloom
cp .env.example .env
# Editar .env con credenciales reales
```

### 2. Crear carpetas de música

```bash
mkdir -p music/songs music/interludios
```

### 3. Arrancar

```bash
docker compose up -d
```

### 4. Exponer stream

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
├── docker-compose.yml               # Stack unificado
├── .env
├── liquidsoap/
│   └── radio.liq                    # Config de Liquidsoap
├── publisher/
│   ├── src/
│   │   ├── index.ts
│   │   ├── api/router.ts
│   │   ├── services/
│   │   ├── repositories/
│   │   └── infrastructure/
│   └── Dockerfile
├── web/
│   └── src/
│       ├── pages/index.astro
│       └── components/Player.astro
└── music/
    ├── songs/          # Canciones (FTP)
    └── interludios/    # Interludios
```

---

## Notas

- **Stack único**: `docker-compose.yml` con bind mounts a `./music/`.
- **FTP**: Sube canciones a `music/songs/` vía FTP.
- **Liquidsoap**: Lee `/music/songs/` y reinicia la playlist cada 300s. Soporta mp3, flac, m4a, ogg.
- **Persistencia**: El estado de reproducción se guarda en SQLite (`radio-publisher-data`). Al reiniciar, retoma la canción donde quedó.
