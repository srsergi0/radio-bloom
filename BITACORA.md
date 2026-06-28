# Bitácora de Radio Bloom

Radio Bloom es una estación de radio por internet automatizada y autogestionada mediante **Liquidsoap**, **Bun (TypeScript)**, **Python (SpotiFLAC)**, y una interfaz web en **Astro**.

---

## 🗺️ Arquitectura General y Conexiones

El sistema está compuesto por 4 microservicios principales que se ejecutan en contenedores Docker compartiendo la red `radio-net`:

1. **`web` (Astro UI)**:
   - **Puerto**: `3000` (despliegue) / `3001` (desarrollo).
   - **Conexión**: Se comunica con el `publisher` usando REST API (puerto `9876` o `3000` según configuración) para obtener el estado actual, timeline, cola de reproducción y enviar comandos (skip, encolar, reordenar).

2. **`publisher` (API Bun + SQLite)**:
   - **Puerto**: `3000` (interno) / `9876` (público API).
   - **Conexión**:
     - **Base de datos**: SQLite (gestionado con Drizzle ORM) para almacenar playlist, cola, historial y configuración del sistema.
     - **Hacia `liquidsoap`**: Se conecta vía **Telnet** (puerto `1234`) para saltar canciones (`skip`) u obtener metadatos activos.
     - **Hacia `downloader`**: Envía solicitudes de descarga de canciones de Spotify vía REST HTTP (puerto `4002`).
     - **Hacia `music/songs`**: Escanea y enriquece la base de datos leyendo los archivos físicos en el disco.

3. **`downloader` (SpotiFLAC Python)**:
   - **Puerto**: `4002`.
   - **Conexión**: Recibe peticiones HTTP del `publisher` con el ID de la canción de Spotify. Usa `SpotiFLAC` para descargar la canción, convirtiéndola y guardándola directamente en el directorio compartido `music/songs/`.

4. **`ftp` (Servidor de Carga de Canciones)**:
   - **Puerto**: `21` (FTP).
   - **Conexión**: Permite la carga directa de canciones vía cliente FTP. Los archivos subidos se guardan en el volumen compartido `music/songs/`. El script de entrada (`entrypoint.sh`) corrige automáticamente los permisos de lectura de los archivos cargados para que Liquidsoap y el Publisher puedan acceder a ellos.

5. **`liquidsoap` (Streaming Engine)**:
   - **Puerto**: `8000` (Harbor) / `1234` (Telnet).
   - **Conexión**: Lee continuamente los archivos de audio en `music/songs/` e `music/interludios/`. Emite el flujo continuo (stream) de audio en formato MP3/FLAC hacia el puerto `8000`. Es controlado por el `publisher` mediante comandos Telnet.

---

## 📁 Árbol de Archivos del Proyecto

A continuación se detalla la estructura completa de archivos y el propósito de cada uno:

```
radio/
├── .env.example                          # Plantilla de variables de entorno (Spotify API, puertos, contraseñas)
├── .env                                  # Archivo de configuración local con credenciales (ignorado en git)
├── .gitignore                            # Archivos excluidos del control de versiones git
├── docker-compose.yml                    # Docker Compose unificado (producción / Coolify)
├── docker-compose.override.yml           # Overrides para desarrollo local (bind mounts)
├── README.md                             # Guía del proyecto (arquitectura, despliegue manual/Coolify y API REST)
├── AGENTS.md                             # Reglas globales de comportamiento y control de herramientas para agentes IA
├── opencode.json                         # Configuración del cliente/agente OpenCode (MCP local/remoto)
│
├── downloader/                           # Microservicio de Descarga
│   ├── Dockerfile                        # Dockerfile optimizado (BuildKit Cache) para la imagen Python del downloader
│   └── server.py                         # Servidor web en Python que expone el endpoint de descarga vía SpotiFLAC
│
├── ftp/                                  # Servidor FTP para subir canciones manualmente
│   ├── Dockerfile                        # Dockerfile basado en vsftpd con soporte para entrypoint personalizado
│   └── entrypoint.sh                     # Corrige permisos de archivos cargados a `music/songs/`
│
├── liquidsoap/                           # Motor de Audio
│   └── radio.liq                         # Script principal de Liquidsoap (lee canciones, gestiona cola y emite streaming)
│
├── music/                                # Directorio de almacenamiento de audios (Volumen compartido)
│   ├── songs/                            # Canciones descargadas o subidas (formatos MP3, FLAC, M4A, OGG)
│   └── interludios/                      # Cuñas, anuncios o sonidos de transición entre pistas
│
├── publisher/                            # Backend API (Bun + TypeScript + Drizzle)
│   ├── Dockerfile                        # Dockerfile optimizado (BuildKit Cache, prod-only deps) para producción con Bun
│   ├── tsconfig.json                     # Configuración del compilador TypeScript
│   ├── package.json                      # Dependencias de npm y scripts de Bun (dev, db:migrate, etc.)
│   ├── drizzle.config.ts                 # Configuración de Drizzle ORM (schema, output, db path)
│   ├── check_db.ts                       # Script de utilidad rápida para verificar la base de datos
│   └── src/                              # Código fuente del Backend
│       ├── index.ts                      # Servidor principal (Elysia, inicialización de servicios)
│       ├── env.ts                        # Tipado y validación de variables de entorno
│       ├── webStandardStreamableHttp.ts  # Soporte de streaming HTTP estándar web
│       ├── mcp-entry.ts                  # Integración del protocolo MCP para agentes IA
│       │
│       ├── api/
│       │   └── router.ts                 # Rutas de la API (Timeline, descargas, skip, cola, etc.)
│       │
│       ├── domain/
│       │   └── types.ts                  # Declaraciones de tipos TypeScript compartidos en la aplicación
│       │
│       ├── infrastructure/               # Clientes y conectores externos
│       │   ├── database.ts               # Inicializador de Drizzle con SQLite (Drizzle / SQLite-Bun)
│       │   ├── ffprobe.client.ts         # Cliente para extraer metadatos de audio físicos mediante `ffprobe`
│       │   ├── spotify.client.ts         # Cliente oficial de la API de Spotify
│       │   ├── spotiflac.client.ts       # Cliente HTTP hacia el contenedor `downloader`
│       │   └── telnet.client.ts          # Cliente de conexión Telnet hacia `liquidsoap`
│       │
│       ├── repositories/                 # Capa de Acceso a Datos (SQLite)
│       │   └── sqlite/
│       │       ├── schema.ts             # Esquema de base de datos Drizzle (timeline, tracks, config, etc.)
│       │       ├── config.repo.ts        # Repositorio de configuración guardada en DB
│       │       ├── library.repo.ts       # Repositorio de biblioteca física (escaneos de canciones locales)
│       │       ├── playback-state.repo.ts# Repositorio del estado de reproducción actual
│       │       └── playlist.repo.ts      # Repositorio CRUD de playlists y tracks (addTrackAtPosition, updateTrack)
│       │
│       └── services/                     # Lógica de Negocio
│           ├── config.service.ts         # Servicio de gestión y persistencia de configuraciones
│           ├── download.service.ts       # Orquestador del flujo de descargas de Spotify
│           ├── library.service.ts        # Escaneador del directorio `music/songs` y catalogación
│           ├── liquidsoap.service.ts     # Sincronización y órdenes sobre el reproductor (incluye playFilesNow)
│           ├── mcp.service.ts            # Implementación de herramientas MCP para interactuar con la radio
│           └── metadata-enrichment.service.ts # Servicio para completar metadatos faltantes mediante Spotify
│
└── web/                                  # Interfaz Frontend (Astro)
    ├── package.json                      # Dependencias npm para la UI web
    ├── tsconfig.json                     # Configuración TypeScript del Frontend
    ├── astro.config.mjs                  # Configuración del framework Astro (SSR, Tailwind/estilos, etc.)
    ├── AGENTS.md                         # Reglas específicas para el desarrollo en el frontend Astro
    ├── CLAUDE.md                         # Duplicado/Guía complementaria de reglas de la web Astro
    ├── README.md                         # Guía de la UI de Astro
    └── src/
        ├── layouts/
        │   └── Layout.astro              # Plantilla HTML global para todas las páginas
        ├── styles/
        │   └── global.css                # Estilos globales y tokens CSS vainilla para la web
        ├── pages/
        │   ├── index.astro               # Redirección e inicializador de la página de inicio
        │   └── es/
        │       └── index.astro           # Página de inicio localizada en español
        └── components/
            ├── EventBanner.astro         # Componente para mostrar eventos especiales programados
            ├── Features.astro            # Sección informativa sobre las capacidades de la radio
            ├── Footer.astro              # Pie de página con enlaces y derechos
            ├── Header.astro              # Cabecera de navegación
            ├── Hero.astro                # Sección de bienvenida principal con visualizaciones
            ├── LiveShow.astro            # Bloque para mostrar el show o artista en vivo
            ├── ProgramList.astro         # Listado de programación de la radio
            ├── Player.astro              # Reproductor de audio con transmisión del stream e info en vivo
            └── ui/                       # Componentes visuales genéricos y reutilizables
                ├── Badge.astro           # Insignia de estado o categorías
                ├── Button.astro          # Botones estilizados interactivos
                └── Card.astro            # Contenedores modulares estilo tarjeta
```

---

## 🔄 Flujo de Trabajo Típico de Datos

Para entender cómo se conectan los archivos durante una operación común:

1. **Añadir una canción vía Spotify**:
   - El usuario hace clic en "Descargar" en el frontend (`web/src/components/Player.astro`).
   - La UI llama a `/api/download` expuesto en `publisher/src/api/router.ts`.
   - `router.ts` delega en `publisher/src/services/download.service.ts`.
   - El servicio llama a `publisher/src/infrastructure/spotiflac.client.ts` para enviar la solicitud HTTP a `downloader/server.py`.
   - `downloader/server.py` corre `spotdl`/`SpotiFLAC` para descargar la canción de Spotify y guardarla en `music/songs/`.
   - Una vez finalizada la descarga, el `library.service.ts` detecta el nuevo archivo físico, extrae sus metadatos con `ffprobe.client.ts` y actualiza la biblioteca usando `library.repo.ts`.
    - El frontend refresca la biblioteca mediante polling REST y renderiza el cambio.

## 🔄 Persistencia de Reproducción (Restore al Reiniciar)

El sistema garantiza que al reiniciar el servidor o los contenedores, la canción se retoma donde quedó:

1. **Guardado automático**: Cada 15 segundos, el publisher guarda el estado actual (archivo, título, artista, posición, duración) en SQLite dentro del volumen `radio-publisher-data`.
2. **Al reiniciar**: El publisher espera 3 segundos, luego reintenta conectarse a Liquidsoap (hasta 60s).
3. **Restore**: Hace `queuePush` del track guardado → `queue.skip` → `seek` a la posición exacta.
4. **Si la canción ya habría terminado**: Limpia el estado y empieza fresco con la playlist de fondo.

Los volúmenes Docker (`radio-music`, `radio-interludios`, `radio-publisher-data`) persisten los datos entre reinicios.

---

## 🎵 API de Playlists (estilo Spotify)

El sistema de playlists permite crear, gestionar y reproducir listas de reproducción con canciones e interludios.

### Endpoints de Playlists

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/playlists` | Crear playlist (body: `{ name }`) |
| `GET` | `/api/playlists` | Listar todas las playlists |
| `GET` | `/api/playlists/:id` | Obtener playlist con tracks |
| `PUT` | `/api/playlists/:id` | Actualizar nombre |
| `DELETE` | `/api/playlists/:id` | Eliminar playlist y tracks |
| `POST` | `/api/playlists/:id/tracks` | Agregar track (acepta `position` opcional) |
| `PUT` | `/api/playlists/:id/tracks/:trackId` | Editar track existente |
| `DELETE` | `/api/playlists/:id/tracks/:trackId` | Eliminar track |
| `PUT` | `/api/playlists/:id/tracks/reorder` | Reordenar tracks (body: `{ trackIds: string[] }`) |
| `POST` | `/api/playlists/:id/play` | **Play now** - limpia cola y reproduce. Acepta `{ shuffle: true }` |
| `POST` | `/api/playlists/:id/queue` | **Añadir a cola** - push al final. Acepta `{ shuffle: true }` |

### Tipos de Track

- `"song"` - Canción normal
- `"interludio"` - Jingle, cuña o transición

### Flujo de Play Now (`POST /api/playlists/:id/play`)

1. Obtiene la playlist con todos sus tracks
2. Mezcla si `shuffle: true`
3. Para tracks con `file` en disco → van directos a la cola
4. Para tracks con `spotifyUrl` → descarga vía SpotiFLAC primero
5. Limpia la cola actual (`queue.clear`)
6. Encola todos los tracks en orden
7. Salta al primero (`queue.skip`)

### Flujo de Queue (`POST /api/playlists/:id/queue`)

1. Obtiene la playlist con todos sus tracks
2. Mezcla si `shuffle: true`
3. Para tracks locales → push al final de la cola
4. Para tracks con `spotifyUrl` → descarga y encola cuando está listo
5. No interrumpe lo que está sonando
