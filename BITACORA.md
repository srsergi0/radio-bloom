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
   - **Puerto**: `21` (FTP).
   - **Conexión**: Permite la carga directa de canciones vía cliente FTP. Los archivos subidos se guardan en el volumen compartido `music/songs/` o `music/interludios/`. El publisher detecta automáticamente los cambios y los indexa.

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
├── docker-compose.yml                    # Docker Compose unificado (producción / Coolify)
├── docker-compose.override.yml           # Overrides para desarrollo local (bind mounts)
├── README.md                             # Guía del proyecto
├── AGENTS.md                             # Reglas globales de comportamiento para agentes IA
├── opencode.json                         # Configuración OpenCode (MCP local/remoto)
│
├── ftp/                                  # Servidor FTP para subir canciones manualmente
│   ├── Dockerfile                        # Dockerfile basado en stilliard/pure-ftpd
│   └── entrypoint.sh                     # Corrige permisos de archivos cargados
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
│       ├── webStandardStreamableHttp.ts  # Soporte de streaming HTTP estándar web
│       ├── mcp-entry.ts                  # Integración del protocolo MCP para agentes IA
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
    ├── AGENTS.md
    ├── public/                           # Archivos estáticos
    └── src/
        ├── layouts/
        │   └── Layout.astro
        ├── styles/
        │   └── global.css
        ├── pages/
        │   ├── index.astro               # Landing Page (Inglés)
        │   ├── admin.astro               # Panel de Gestión de Locutores de IA (Inglés)
        │   └── es/
        │       ├── index.astro           # Landing Page (Español)
        │       └── admin.astro           # Panel de Gestión de Locutores de IA (Español)
        └── components/
            ├── EventBanner.astro
            ├── Features.astro
            ├── Footer.astro
            ├── Header.astro
            ├── Hero.astro
            ├── LiveShow.astro
            ├── ProgramList.astro
            ├── Player.astro
            └── ui/
                ├── Badge.astro
                ├── Button.astro
                └── Card.astro
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
3. **Restore**: Hace `queuePush` del track guardado → `queue.skip` → `seek` a la posición exacta.
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

