import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spotifySearch } from "../infrastructure/spotify.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlaylistRepository } from "../repositories/sqlite/playlist.repo";
import { WebStandardStreamableHTTPServerTransport } from "../webStandardStreamableHttp.js";
import type { LibraryService } from "./library.service";
import type { LiquidsoapService } from "./liquidsoap.service";
import { TorrentService } from "./torrent.service";

export class McpService {
  private readonly server: McpServer;
  private readonly torrentService: TorrentService;
  private readonly sessions = new Map<
    string,
    {
      server: McpServer;
      transport: WebStandardStreamableHTTPServerTransport;
    }
  >();

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly playlistRepo: PlaylistRepository,
    private readonly libraryService: LibraryService,
    private readonly liquidsoapService: LiquidsoapService
  ) {
    this.server = new McpServer({
      name: "radio-bloom",
      version: "1.0.0",
    });
    this.torrentService = new TorrentService();
    this.registerAllTools(this.server);
  }

  private registerAllTools(server: McpServer) {
    server.tool(
      "radio_status",
      "Estado actual del stream: qué está sonando, cola, etc.",
      {},
      async () => {
        try {
          const status = await this.liquidsoapService.getStreamStatus();
          const queue = await this.liquidsoapService.queueList();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status, queue }, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "radio_search",
      "Buscar canciones e interludios en la biblioteca por nombre, artista o álbum",
      {
        query: z.string().describe("Término de búsqueda"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Número máximo de resultados (default: 10)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Desde qué posición empezar (default: 0)"),
      },
      async ({ query, limit, offset }) => {
        const { items, total } = this.libraryRepo.search(query, limit, offset);
        return {
          content: [
            {
              type: "text",
              text:
                total === 0
                  ? "No se encontraron resultados"
                  : JSON.stringify(
                      {
                        total,
                        showing: items.length,
                        offset,
                        items: items.map((r) => ({
                          id: r.id,
                          file: r.file,
                          title: r.title,
                          artist: r.artist,
                          type: r.type,
                          duration: r.duration,
                        })),
                      },
                      null,
                      2
                    ),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_spotify_search",
      "Buscar canciones en Spotify por nombre, artista o álbum",
      {
        query: z.string().describe("Término de búsqueda"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Número máximo de resultados (default: 10)"),
      },
      async ({ query, limit }) => {
        try {
          const results = await spotifySearch(query, limit);
          return {
            content: [
              {
                type: "text",
                text:
                  results.length === 0
                    ? "No se encontraron resultados en Spotify"
                    : JSON.stringify({ total: results.length, items: results }, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "radio_queue_list",
      "Listar el contenido actual de la cola de reproducción",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(5)
          .describe("Número máximo de elementos a mostrar (default: 5, recomendado)"),
      },
      async ({ limit }) => {
        const queue = await this.liquidsoapService.queueList();
        const items = queue.slice(0, limit);
        return {
          content: [
            {
              type: "text",
              text:
                queue.length === 0
                  ? "Cola vacía"
                  : JSON.stringify(
                      {
                        total: queue.length,
                        showing: items.length,
                        items: items.map((q, i) => ({ position: i + 1, ...q })),
                      },
                      null,
                      2
                    ),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_queue_add",
      "Añadir una canción o interludio al final de la cola usando su ID de la biblioteca. Usa el campo 'id' que devuelve radio_search",
      {
        id: z
          .string()
          .describe("ID del track en la biblioteca (campo 'id' que devuelve radio_search)"),
      },
      async ({ id }) => {
        const track = this.libraryRepo.getTrackById(id);
        if (!track)
          return {
            content: [{ type: "text", text: `Track con ID '${id}' no existe en la biblioteca` }],
            isError: true,
          };
        const filepath = `/music/${track.file}`;
        const rid = await this.liquidsoapService.queuePush(filepath);
        if (!rid) return { content: [{ type: "text", text: "Error al encolar" }], isError: true };
        const queue = await this.liquidsoapService.queueList();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, rid, queue: queue.map((q, i) => ({ position: i + 1, ...q })) },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_queue_insert",
      "Insertar una canción o interludio en una posición específica de la cola usando su ID de la biblioteca. La posición 1 es la siguiente en reproducirse",
      {
        position: z
          .number()
          .int()
          .min(1)
          .describe("Posición donde insertar (1 = siguiente en reproducirse)"),
        id: z.string().describe("ID del track en la biblioteca (campo 'id' de radio_search)"),
      },
      async ({ position, id }) => {
        const track = this.libraryRepo.getTrackById(id) || this.libraryRepo.getTrackByFile(id);
        if (!track)
          return {
            content: [{ type: "text", text: `Track con ID '${id}' no existe en la biblioteca` }],
            isError: true,
          };
        const filepath = `/music/${track.file}`;
        const ok = await this.liquidsoapService.queueInsert(position - 1, filepath);
        if (!ok)
          return { content: [{ type: "text", text: "Error al insertar en cola" }], isError: true };
        const queue = await this.liquidsoapService.queueList();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, queue: queue.map((q, i) => ({ position: i + 1, ...q })) },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_queue_remove",
      "Eliminar un elemento de la cola por su posición",
      {
        position: z
          .number()
          .int()
          .min(1)
          .describe("Posición del elemento a eliminar (1 = el siguiente en reproducirse)"),
      },
      async ({ position }) => {
        const queue = await this.liquidsoapService.queueList();
        if (position > queue.length) {
          return {
            content: [
              {
                type: "text",
                text: `Posición ${position} no existe, la cola tiene ${queue.length} elementos`,
              },
            ],
            isError: true,
          };
        }
        const rid = queue[position - 1].rid;
        const ok = await this.liquidsoapService.queueRemove(rid);
        if (!ok) return { content: [{ type: "text", text: "Error al eliminar" }], isError: true };
        const newQueue = await this.liquidsoapService.queueList();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  removed: position,
                  queue: newQueue.map((q, i) => ({ position: i + 1, ...q })),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool("radio_queue_clear", "Vaciar toda la cola de reproducción", {}, async () => {
      await this.liquidsoapService.queueClear();
      return { content: [{ type: "text", text: "Cola vaciada" }] };
    });

    server.tool(
      "radio_play_now",
      "Reproducir una canción o interludio inmediatamente (limpia la cola y la salta) usando su ID de la biblioteca",
      {
        id: z.string().describe("ID del track en la biblioteca (campo 'id' de radio_search)"),
      },
      async ({ id }) => {
        const track = this.libraryRepo.getTrackById(id) || this.libraryRepo.getTrackByFile(id);
        if (!track)
          return {
            content: [{ type: "text", text: `Track con ID '${id}' no existe en la biblioteca` }],
            isError: true,
          };
        const filepath = `/music/${track.file}`;
        const ok = await this.liquidsoapService.playFileNow(filepath);
        if (!ok) return { content: [{ type: "text", text: "Error al reproducir" }], isError: true };
        return { content: [{ type: "text", text: `Reproduciendo: ${track.title}` }] };
      }
    );

    server.tool("radio_skip", "Saltar a la siguiente canción en la cola", {}, async () => {
      await this.liquidsoapService.skipTrack();
      return { content: [{ type: "text", text: "Skip ejecutado" }] };
    });

    // ========== Torrent Tools ==========

    server.tool(
      "torrent_search",
      "Buscar torrents de música en The Pirate Bay. Retorna links magnet para descargar.",
      {
        query: z.string().describe("Término de búsqueda (artista - canción)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe("Número máximo de resultados (default: 5)"),
      },
      async ({ query, limit }) => {
        try {
          const results = await this.torrentService.search(query, limit);
          return {
            content: [
              {
                type: "text",
                text:
                  results.length === 0
                    ? "No se encontraron torrents"
                    : JSON.stringify(
                        {
                          total: results.length,
                          items: results.map((r, i) => ({
                            position: i + 1,
                            name: r.name,
                            seeds: r.seeds,
                            leechers: r.leechers,
                            size: `${r.size.toFixed(1)} MB`,
                            magnet: r.magnet,
                          })),
                        },
                        null,
                        2
                      ),
              },
            ],
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "torrent_queue_download",
      "Agregar una descarga de torrent a la cola. Usa el magnet link de torrent_search.",
      {
        magnet: z.string().describe("Link magnet del torrent"),
        name: z.string().describe("Nombre para la descarga"),
      },
      async ({ magnet, name }) => {
        try {
          const job = await this.torrentService.queueDownload(magnet, name);
          const stats = await this.torrentService.getQueueStats();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: true,
                    jobId: job.id,
                    name: job.name,
                    status: job.status,
                    queuePosition: stats.pending,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "torrent_check_status",
      "Verificar estado de una descarga en la cola",
      {
        jobId: z.string().describe("ID del trabajo (retornado por torrent_queue_download)"),
      },
      async ({ jobId }) => {
        try {
          const job = await this.torrentService.getJobStatus(jobId);
          if (!job) {
            return {
              content: [{ type: "text", text: `Trabajo con ID '${jobId}' no encontrado` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(job, null, 2),
              },
            ],
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool("torrent_queue_status", "Estado general de la cola de descargas", {}, async () => {
      try {
        const stats = await this.torrentService.getQueueStats();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    });

    server.tool(
      "torrent_list_queue",
      "Listar las descargas recientes en la cola",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Número máximo de resultados (default: 10)"),
      },
      async ({ limit }) => {
        try {
          const jobs = await this.torrentService.listJobs(limit);
          return {
            content: [
              {
                type: "text",
                text:
                  jobs.length === 0
                    ? "No hay descargas en la cola"
                    : JSON.stringify(
                        {
                          total: jobs.length,
                          items: jobs.map((j) => ({
                            id: j.id,
                            name: j.name,
                            status: j.status,
                            progress: j.progress,
                            createdAt: j.createdAt,
                          })),
                        },
                        null,
                        2
                      ),
              },
            ],
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "torrent_cancel",
      "Cancelar una descarga en cola (solo si está en estado 'queued')",
      {
        jobId: z.string().describe("ID del trabajo a cancelar"),
      },
      async ({ jobId }) => {
        try {
          const cancelled = await this.torrentService.cancelJob(jobId);
          return {
            content: [
              {
                type: "text",
                text: cancelled
                  ? `Trabajo ${jobId} cancelado`
                  : `No se pudo cancelar ${jobId} (puede que ya esté descargando)`,
              },
            ],
          };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "radio_library_stats",
      "Estadísticas de la biblioteca: total de canciones e interludios",
      {},
      async () => {
        const songs = this.libraryRepo.countTracks("song");
        const interludios = this.libraryRepo.countTracks("interludio");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ songs, interludios, total: songs + interludios }, null, 2),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_list_songs",
      "Listar canciones de la biblioteca. Usa limit y offset para paginar (default: 5)",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(5)
          .describe("Número máximo de canciones (default: 5, recomendado)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Desde qué posición empezar (default: 0)"),
      },
      async ({ limit, offset }) => {
        const { items, total } = this.libraryService.listSongsPage(limit, offset);
        return {
          content: [
            {
              type: "text",
              text:
                total === 0
                  ? "No hay canciones"
                  : JSON.stringify(
                      {
                        total,
                        showing: items.length,
                        offset,
                        items: items.map((s) => ({
                          id: s.id,
                          file: s.file,
                          title: s.title,
                          artist: s.artist,
                          duration: s.duration,
                        })),
                      },
                      null,
                      2
                    ),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_list_interludios",
      "Listar interludios de la biblioteca. Usa limit y offset para paginar (default: 5)",
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(5)
          .describe("Número máximo de interludios (default: 5, recomendado)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Desde qué posición empezar (default: 0)"),
      },
      async ({ limit, offset }) => {
        const { items, total } = this.libraryService.listInterludiosPage(limit, offset);
        return {
          content: [
            {
              type: "text",
              text:
                total === 0
                  ? "No hay interludios"
                  : JSON.stringify(
                      {
                        total,
                        showing: items.length,
                        offset,
                        items: items.map((i) => ({
                          id: i.id,
                          file: i.file,
                          title: i.title,
                          duration: i.duration,
                        })),
                      },
                      null,
                      2
                    ),
            },
          ],
        };
      }
    );

    server.tool("radio_playlist_list", "Listar todas las playlists guardadas", {}, async () => {
      const playlists = this.playlistRepo.list();
      return {
        content: [
          {
            type: "text",
            text:
              playlists.length === 0
                ? "No hay playlists"
                : JSON.stringify(
                    playlists.map((p) => ({
                      id: p.id,
                      name: p.name,
                      tracks: p.tracks.length,
                      updatedAt: p.updatedAt,
                    })),
                    null,
                    2
                  ),
          },
        ],
      };
    });

    server.tool(
      "radio_playlist_get",
      "Obtener una playlist con todas sus canciones e interludios",
      {
        id: z.string().describe("ID de la playlist"),
      },
      async ({ id }) => {
        const playlist = this.playlistRepo.get(id);
        if (!playlist)
          return { content: [{ type: "text", text: "Playlist no encontrada" }], isError: true };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(playlist, null, 2),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_playlist_create",
      "Crear una nueva playlist vacía",
      {
        name: z.string().describe("Nombre de la playlist"),
      },
      async ({ name }) => {
        const playlist = this.playlistRepo.create(name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(playlist, null, 2),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_playlist_add_track",
      "Añadir una canción o interludio a una playlist. Si se proporciona libraryTrackId, se rellenan automáticamente title, artist, file y duration desde la biblioteca",
      {
        playlistId: z.string().describe("ID de la playlist"),
        libraryTrackId: z
          .string()
          .optional()
          .describe(
            "ID del track en la biblioteca (rellena automáticamente title, artist, file, duration)"
          ),
        title: z.string().optional().describe("Título (obligatorio si no se usa libraryTrackId)"),
        artist: z.string().optional().describe("Artista"),
        file: z
          .string()
          .optional()
          .describe("Ruta del archivo relativa (ej: 'songs/mi-tema.mp3' o 'interludios/cuna.wav')"),
        duration: z.number().int().optional().default(0).describe("Duración en segundos"),
        type: z.enum(["song", "interludio"]).optional().default("song").describe("Tipo de track"),
      },
      async ({ playlistId, libraryTrackId, title, artist, file, duration, type }) => {
        let resolvedTitle = title || "";
        let resolvedArtist = artist || "";
        let resolvedFile = file || undefined;
        let resolvedDuration = duration || 0;
        let resolvedType = type;

        if (libraryTrackId) {
          const libTrack = this.libraryRepo.getTrackById(libraryTrackId);
          if (!libTrack)
            return {
              content: [
                {
                  type: "text",
                  text: `Track con ID '${libraryTrackId}' no existe en la biblioteca`,
                },
              ],
              isError: true,
            };
          resolvedTitle = libTrack.title;
          resolvedArtist = libTrack.artist || "";
          resolvedFile = libTrack.file;
          resolvedDuration = libTrack.duration;
          resolvedType = libTrack.type as "song" | "interludio";
        } else if (!resolvedTitle) {
          return {
            content: [{ type: "text", text: "Se requiere 'title' o 'libraryTrackId'" }],
            isError: true,
          };
        }

        const track = this.playlistRepo.addTrack(playlistId, {
          type: resolvedType,
          file: resolvedFile,
          title: resolvedTitle,
          artist: resolvedArtist,
          duration: resolvedDuration,
        });
        if (!track)
          return { content: [{ type: "text", text: "Playlist no encontrada" }], isError: true };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(track, null, 2),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_playlist_play",
      "Reproducir una playlist inmediatamente. Las canciones se encolan en el orden definido en la playlist",
      {
        id: z.string().describe("ID de la playlist"),
        shuffle: z.boolean().optional().default(false).describe("Mezclar aleatoriamente"),
      },
      async ({ id, shuffle }) => {
        const playlist = this.playlistRepo.get(id);
        if (!playlist)
          return { content: [{ type: "text", text: "Playlist no encontrada" }], isError: true };
        if (playlist.tracks.length === 0)
          return { content: [{ type: "text", text: "Playlist vacía" }], isError: true };

        const tracks = [...playlist.tracks];
        if (shuffle) {
          for (let i = tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
          }
        }

        const filepaths: string[] = [];
        const results: { pos: number; title: string; status: string }[] = [];

        for (const track of tracks) {
          if (track.file) {
            const filepath = `/music/${track.file}`;
            filepaths.push(filepath);
            results.push({ pos: track.pos, title: track.title, status: "queued" });
          } else {
            results.push({ pos: track.pos, title: track.title, status: "skipped: no file" });
          }
        }

        let firstPlayed = false;
        if (filepaths.length > 0) {
          firstPlayed = await this.liquidsoapService.playFilesNow(filepaths);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  playlistId: id,
                  name: playlist.name,
                  shuffle,
                  total: tracks.length,
                  queued: filepaths.length,
                  skipped: tracks.length - filepaths.length,
                  firstPlayed,
                  results,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }

  public async startStdioServer(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log("[McpService] MCP Stdio Server running.");
  }

  public async handleHttpRequest(req: Request): Promise<Response> {
    let isInit = false;
    if (req.method === "POST") {
      try {
        const cloned = req.clone();
        const body = await cloned.json();
        const messages = Array.isArray(body) ? body : [body];
        isInit = messages.some((m: any) => m.method === "initialize");
      } catch {}
    }

    if (isInit) {
      const sessionServer = new McpServer({
        name: "radio-bloom",
        version: "1.0.0",
      });
      this.registerAllTools(sessionServer);

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId) => {
          this.sessions.set(sessionId, { server: sessionServer, transport });
          console.log(`[McpService] MCP Session initialized: ${sessionId}`);
        },
        onsessionclosed: (sessionId) => {
          const session = this.sessions.get(sessionId);
          if (session) {
            session.transport.close().catch(() => {});
            this.sessions.delete(sessionId);
            console.log(`[McpService] MCP Session closed: ${sessionId}`);
          }
        },
      });

      await sessionServer.connect(transport);
      return transport.handleRequest(req);
    }

    const sessionId = req.headers.get("mcp-session-id");
    if (!sessionId) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
          id: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return session.transport.handleRequest(req);
  }
}
