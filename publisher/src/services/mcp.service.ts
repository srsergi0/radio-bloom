import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlaylistRepository } from "../repositories/sqlite/playlist.repo";
import { WebStandardStreamableHTTPServerTransport } from "../webStandardStreamableHttp.js";
import type { DownloadService } from "./download.service";
import type { LibraryService } from "./library.service";
import type { LiquidsoapService } from "./liquidsoap.service";

export class McpService {
  private readonly server: McpServer;
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
    private readonly liquidsoapService: LiquidsoapService,
    private readonly downloadService: DownloadService
  ) {
    this.server = new McpServer({
      name: "radio-bloom",
      version: "1.0.0",
    });
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
      "Añadir una canción o interludio al final de la cola. Usa el campo 'file' que devuelve radio_search",
      {
        file: z
          .string()
          .describe(
            "Ruta del archivo (campo 'file' del track, ej: 'songs/mi-tema.mp3' o 'interludios/pausa.mp3')"
          ),
      },
      async ({ file }) => {
        const track = this.libraryRepo.getTrackByFile(file);
        if (!track)
          return {
            content: [{ type: "text", text: `El archivo '${file}' no existe en la biblioteca` }],
            isError: true,
          };
        const filepath = `/music/${file}`;
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
      "Insertar una canción o interludio en una posición específica de la cola. La posición 1 es la siguiente en reproducirse",
      {
        position: z
          .number()
          .int()
          .min(1)
          .describe("Posición donde insertar (1 = siguiente en reproducirse)"),
        file: z.string().describe("Ruta del archivo (campo 'file' del track)"),
      },
      async ({ position, file }) => {
        const track = this.libraryRepo.getTrackByFile(file);
        if (!track)
          return {
            content: [{ type: "text", text: `El archivo '${file}' no existe en la biblioteca` }],
            isError: true,
          };
        const filepath = `/music/${file}`;
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
      "Reproducir una canción o interludio inmediatamente (limpia la cola y la salta)",
      {
        file: z.string().describe("Ruta del archivo (campo 'file' del track)"),
      },
      async ({ file }) => {
        const track = this.libraryRepo.getTrackByFile(file);
        if (!track)
          return {
            content: [{ type: "text", text: `El archivo '${file}' no existe en la biblioteca` }],
            isError: true,
          };
        const filepath = `/music/${file}`;
        const ok = await this.liquidsoapService.playFileNow(filepath);
        if (!ok) return { content: [{ type: "text", text: "Error al reproducir" }], isError: true };
        return { content: [{ type: "text", text: `Reproduciendo: ${file}` }] };
      }
    );

    server.tool("radio_skip", "Saltar a la siguiente canción en la cola", {}, async () => {
      await this.liquidsoapService.skipTrack();
      return { content: [{ type: "text", text: "Skip ejecutado" }] };
    });

    server.tool(
      "radio_library_stats",
      "Estadísticas de la biblioteca: total de canciones e interludios",
      {},
      async () => {
        return {
          content: [
            {
              type: "text",
              text: "Library stats removed",
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
      "Añadir una canción o interludio a una playlist. Si tiene spotifyUrl se descargará al reproducir la playlist",
      {
        playlistId: z.string().describe("ID de la playlist"),
        title: z.string().describe("Título de la canción"),
        artist: z.string().optional().describe("Artista"),
        spotifyUrl: z
          .string()
          .optional()
          .describe("URL de Spotify (https://open.spotify.com/track/...)"),
        duration: z.number().int().optional().default(0).describe("Duración en segundos"),
        type: z.enum(["song", "interludio"]).optional().default("song").describe("Tipo de track"),
      },
      async ({ playlistId, title, artist, spotifyUrl, duration, type }) => {
        const track = this.playlistRepo.addTrack(playlistId, {
          type,
          title,
          artist,
          duration,
          spotifyUrl,
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
      "radio_queue_add_url",
      "Añadir una URL de Spotify a la cola de reproducción. Descarga automáticamente si no está en la biblioteca",
      {
        url: z.string().describe("URL de Spotify (https://open.spotify.com/track/...)"),
      },
      async ({ url }) => {
        const existing = this.libraryRepo.getTrackByUrl(url);
        if (existing) {
          const rid = await this.liquidsoapService.queuePush(`/music/${existing.file}`);
          const queue = await this.liquidsoapService.queueList();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: !!rid,
                    source: "library",
                    track: existing.title,
                    queue: queue.map((q, i) => ({ position: i + 1, ...q })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        this.downloadService.downloadFromSpotify(url, async (track) => {
          const rid = await this.liquidsoapService.queuePush(`/music/${track.file}`);
          console.log(`[MCP] Queued downloaded track: ${track.title} rid=${rid}`);
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  source: "download",
                  message: "Descarga iniciada. Se encolará automáticamente al completarse.",
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
      "radio_playlist_play",
      "Reproducir una playlist inmediatamente. Descarga automáticamente canciones de Spotify si es necesario",
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

        const local: string[] = [];
        const pending: { track: (typeof tracks)[0] }[] = [];
        let firstPlayed = false;
        let firstDownloadFired = false;

        for (const track of tracks) {
          const filepath = track.file ? `/music/${track.file}` : "";
          if (filepath) {
            local.push(filepath);
            continue;
          }
          if (track.spotifyUrl) {
            const libTrack = this.libraryRepo.getTrackByUrl(track.spotifyUrl);
            if (libTrack) {
              local.push(`/music/${libTrack.file}`);
              continue;
            }
            pending.push({ track });
          }
        }

        // Play local files immediately
        if (local.length > 0) {
          firstPlayed = await this.liquidsoapService.playFilesNow(local);
        }

        // Fire pending downloads asynchronously
        for (const p of pending) {
          this.downloadService
            .downloadFromSpotify(p.track.spotifyUrl!, async (downloaded) => {
              const fp = `/music/${downloaded.file}`;
              if (!firstPlayed && !firstDownloadFired) {
                firstDownloadFired = true;
                await this.liquidsoapService.sendCommand("queue.flush_and_skip").catch(() => {});
                await new Promise((r) => setTimeout(r, 500));
                await this.liquidsoapService.queuePush(fp);
                firstPlayed = true;
              } else {
                await this.liquidsoapService.queuePush(fp);
              }
            })
            .catch(() => {});
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
                  localQueued: local.length,
                  pendingDownloads: pending.length,
                  firstPlayed,
                  message:
                    pending.length > 0
                      ? `${local.length} canciones encoladas, ${pending.length} descargándose...`
                      : `${local.length} canciones encoladas`,
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
