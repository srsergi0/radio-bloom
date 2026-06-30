# Torrent Integration for Radio Bloom Publisher

## Nuevas Tools MCP

Se han agregado las siguientes tools al MCP server:

| Tool | Descripción |
|------|-------------|
| `torrent_search` | Buscar torrents de música en The Pirate Bay |
| `torrent_queue_download` | Agregar una descarga a la cola |
| `torrent_check_status` | Verificar estado de una descarga |
| `torrent_queue_status` | Estado general de la cola |
| `torrent_list_queue` | Listar descargas recientes |
| `torrent_cancel` | Cancelar una descarga en cola |

## Configuración

### 1. Instalar dependencias

```bash
bun install
```

### 2. Configurar Redis

```bash
# Opcional: usar docker-compose
docker compose -f docker-compose.worker.yml up -d redis
```

### 3. Ejecutar el worker (procesador de descargas)

```bash
bun run worker
```

### 4. Ejecutar el MCP server (como siempre)

```bash
bun run mcp
```

## Uso desde el LLM

### Buscar música

```
Usuario: "Busca After Midnight de Chappell Roan"
LLM ejecuta: torrent_search(query="After Midnight Chappell Roan")
```

### Descargar

```
Usuario: "Descarga el primero"
LLM ejecuta: torrent_queue_download(magnet="magnet:...", name="After Midnight")
```

### Verificar estado

```
Usuario: "¿Ya terminó?"
LLM ejecuta: torrent_check_status(jobId="abc123")
```

## Flujo completo

```
┌─────────────────┐
│  LLM (OpenRouter)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  MCP Server     │
│  (radio-bloom)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Redis Queue    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Worker (bun)   │
│  aria2c download│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  /app/downloads │
└─────────────────┘
```

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379/0` | URL de Redis |
| `DOWNLOAD_DIR` | `./downloads` | Directorio de descargas |

## Notas

- El worker procesa descargas secuencialmente (1 a la vez)
- Las descargas usan aria2c con múltiples conexiones
- Timeout de 15 minutos por descarga
- Los archivos se guardan como MP3/FLAC/WAV
