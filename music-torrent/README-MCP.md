# Ejemplo de uso con OpenRouter + MCP

## 1. Instalar dependencias

```bash
pip install -r requirements-mcp.txt
```

## 2. Ejecutar el MCP server

```bash
python server.py
```

## 3. Configurar en tu MCP client (opencode.json)

```json
{
  "mcp": {
    "servers": {
      "music-torrent": {
        "command": "python",
        "args": ["D:/cursos/SEED-AUDIO/radio/music-torrent/server.py"],
        "env": {
          "DOWNLOAD_DIR": "D:/cursos/SEED-AUDIO/radio/music-downloads"
        }
      }
    }
  }
}
```

## 4. Usar en tu LLM (OpenRouter)

Una vez conectado, tu LLM podrá usar estas tools:

### Tool: search_torrents
```json
{
  "name": "search_torrents",
  "arguments": {
    "query": "After Midnight Chappell Roan",
    "limit": 5
  }
}
```

### Tool: download_torrent
```json
{
  "name": "download_torrent",
  "arguments": {
    "magnet": "magnet:?xt=urn:btih:...",
    "name": "Chappell Roan - After Midnight"
  }
}
```

### Tool: list_downloads
```json
{
  "name": "list_downloads",
  "arguments": {}
}
```

## 5. Flujo completo

```
Usuario: "Descarga After Midnight de Chappell Roan"
    ↓
LLM (OpenRouter): "Voy a buscar el torrent"
    ↓
MCP Client → MCP Server → search_torrents("After Midnight Chappell Roan")
    ↓
LLM: "Encontré 5 resultados. ¿Cuál quieres?"
    ↓
Usuario: "El primero"
    ↓
LLM: "Descargando..."
    ↓
MCP Client → MCP Server → download_torrent(magnet_link)
    ↓
LLM: "Descargado exitosamente en /data/music/"
```

## Notas

- El MCP server corre como un proceso separado
- El LLM se comunica con el server via stdio
- Los archivos se descargan en DOWNLOAD_DIR
- Puedes agregar más tools (convert to MP3, search lyrics, etc.)
