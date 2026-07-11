import { HttpTransport, McpServer, StdioTransport } from "mcp-lite";
import { listVoices, type Voice } from "edge-tts-universal";
import { z } from "zod";
import { spotifySearch } from "../infrastructure/spotify.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlaylistRepository } from "../repositories/sqlite/playlist.repo";
import type { LibraryService } from "./library.service";
import type { BuncasterService } from "./buncaster.service";
import type { TorrentService } from "./torrent.service";

export class McpService {
  private readonly server: McpServer;
  private httpTransport: HttpTransport | null = null;
  private currentSessionId: string | null = null;

  constructor(
    private readonly libraryRepo: LibraryRepository,
    private readonly playlistRepo: PlaylistRepository,
    private readonly libraryService: LibraryService,
    private readonly buncasterService: BuncasterService,
    private readonly torrentService: TorrentService
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
          const [status, queue] = await Promise.all([
            this.buncasterService.getStreamStatus(),
            this.buncasterService.queueList(20),
          ]);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { status, queue: queue.items, queueTotal: queue.total },
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
      "radio_tts_voices",
      "Listar voces disponibles para TTS (Text-to-Speech). Filtrar por idioma o género para encontrar la voz ideal para interludios",
      {
        language: z
          .string()
          .optional()
          .describe("Filtrar por idioma (ej: 'es' para español, 'en' para inglés)"),
        gender: z.string().optional().describe("Filtrar por género: 'Male' o 'Female'"),
      },
      async ({ language, gender }) => {
        try {
          const allVoices = await listVoices();
          let filtered = allVoices;

          if (language) {
            const lang = language.toLowerCase();
            filtered = filtered.filter(
              (v) => v.Locale.toLowerCase().startsWith(lang) || v.Name.toLowerCase().includes(lang)
            );
          }
          if (gender) {
            const g = gender.charAt(0).toUpperCase() + gender.slice(1).toLowerCase();
            filtered = filtered.filter((v) => v.Gender === g);
          }

          const voices = filtered.map((v) => ({
            shortName: v.ShortName,
            name: v.Name,
            gender: v.Gender,
            locale: v.Locale,
            languages: v.VoiceTag.ContentCategories,
            personalities: v.VoiceTag.VoicePersonalities,
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    total: voices.length,
                    filter: { language, gender },
                    voices: voices.slice(0, 50),
                    hint:
                      voices.length > 50
                        ? `Mostrando 50 de ${voices.length}. Usa language/gender para filtrar`
                        : undefined,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error al obtener voces: ${err.message}` }],
            isError: true,
          };
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
        const { items, total } = await this.buncasterService.queueList(limit);
        return {
          content: [
            {
              type: "text",
              text:
                total === 0
                  ? "Cola vacía"
                  : JSON.stringify(
                      {
                        total,
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
      "Añadir canciones e interludios al final de la cola. Acepta un ID individual o un array de IDs para encolar múltiples en orden. También soporta TTS con { script, voice }. Usa radio_tts_voices para ver voces disponibles",
      {
        id: z
          .string()
          .optional()
          .describe(
            "ID del track en la biblioteca (campo 'id' que devuelve radio_search). Para un solo track"
          ),
        ids: z
          .array(z.string())
          .optional()
          .describe("Array de IDs para encolar múltiples tracks en orden"),
        tracks: z
          .array(
            z.object({
              id: z.string().optional().describe("ID del track en la biblioteca"),
              script: z.string().optional().describe("Texto para generar interludio TTS"),
              voice: z
                .string()
                .optional()
                .describe(
                  "Voz para TTS (ver radio_tts_voices para opciones, default: es-ES-AlvaroNeural)"
                ),
            })
          )
          .optional()
          .describe("Array de objetos con id, o script+voice para TTS"),
      },
      async ({
        id,
        ids,
        tracks,
      }: {
        id?: string;
        ids?: string[];
        tracks?: { id?: string; script?: string; voice?: string }[];
      }) => {
        const items: { id?: string; script?: string; voice?: string }[] = [];

        if (tracks && tracks.length > 0) {
          items.push(...tracks);
        } else if (ids && ids.length > 0) {
          items.push(...ids.map((trackId) => ({ id: trackId })));
        } else if (id) {
          items.push({ id });
        } else {
          return {
            content: [{ type: "text", text: "Se requiere 'id', 'ids' o 'tracks'" }],
            isError: true,
          };
        }

        const queued: { id: string; title: string; type: string }[] = [];
        const errors: { id?: string; script?: string; error: string }[] = [];

        for (const item of items) {
          if (item.id) {
            const track = this.libraryRepo.getTrackById(item.id);
            if (!track) {
              errors.push({ id: item.id, error: `Track '${item.id}' no existe` });
              continue;
            }
            const filepath = `/music/${track.file}`;
            const rid = await this.buncasterService.queuePush(filepath);
            if (!rid) {
              errors.push({ id: item.id, error: "Error al encolar" });
              continue;
            }
            queued.push({ id: track.id, title: track.title, type: track.type });
          } else if (item.script) {
            // TTS interludio - usar el endpoint HTTP que tiene BullMQ
            const res = await fetch("http://localhost:3000/api/stream/queue", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ script: item.script, voice: item.voice }),
            });
            const data = await res.json();
            if (data.ok) {
              queued.push({ id: "tts", title: item.script.slice(0, 50), type: "interludio" });
            } else {
              errors.push({ script: item.script, error: data.error || "Error TTS" });
            }
          }
        }

        const { items: queueItems } = await this.buncasterService.queueList();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: errors.length === 0,
                  queued: queued.length,
                  skipped: errors.length,
                  items: queued,
                  errors: errors.length > 0 ? errors : undefined,
                  queue: queueItems.map((q, i) => ({ position: i + 1, ...q })),
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
        const ok = await this.buncasterService.queueInsert(position - 1, filepath);
        if (!ok)
          return { content: [{ type: "text", text: "Error al insertar en cola" }], isError: true };
        const { items: queueItems } = await this.buncasterService.queueList();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, queue: queueItems.map((q, i) => ({ position: i + 1, ...q })) },
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
        const { items: queueItems, total } = await this.buncasterService.queueList();
        if (position > total) {
          return {
            content: [
              {
                type: "text",
                text: `Posición ${position} no existe, la cola tiene ${total} elementos`,
              },
            ],
            isError: true,
          };
        }
        const rid = queueItems[position - 1].rid;
        const ok = await this.buncasterService.queueRemove(rid);
        if (!ok) return { content: [{ type: "text", text: "Error al eliminar" }], isError: true };
        const { items: newQueueItems } = await this.buncasterService.queueList();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  removed: position,
                  queue: newQueueItems.map((q, i) => ({ position: i + 1, ...q })),
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
      await this.buncasterService.queueClear();
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
        const ok = await this.buncasterService.playFileNow(filepath);
        if (!ok) return { content: [{ type: "text", text: "Error al reproducir" }], isError: true };
        return { content: [{ type: "text", text: `Reproduciendo: ${track.title}` }] };
      }
    );

    server.tool("radio_skip", "Saltar a la siguiente canción en la cola", {}, async () => {
      await this.buncasterService.skipTrack();
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
                    status: await job.getState(),
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
      "torrent_job_logs",
      "Obtener los logs en tiempo real o finales de una descarga activa o terminada",
      {
        jobId: z.string().describe("ID del job de descarga"),
      },
      async ({ jobId }) => {
        try {
          const result = await this.torrentService.getJobLogs(jobId);
          return {
            content: [
              {
                type: "text",
                text:
                  result.logs.length === 0
                    ? "No hay logs para este job aún"
                    : result.logs.join("\n"),
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

    server.tool(
      "radio_interludio_create",
      "Crear un interludio TTS (texto a voz) y guardarlo en la biblioteca. Devuelve el track con su ID para usarlo luego en radio_playlist_add_track. workflow: 1) crear interludios 2) añadirlos a playlist por ID",
      {
        title: z.string().describe("Título descriptivo del interludio"),
        script: z.string().describe("Texto a sintetizar (lo que se escuchará)"),
        voice: z
          .string()
          .optional()
          .describe("Voz TTS (ver radio_tts_voices, default: es-ES-AlvaroNeural)"),
      },
      async ({ title, script, voice }) => {
        try {
          const body: Record<string, any> = { title, script };
          if (voice) body.voice = voice;
          const res = await fetch("http://localhost:3000/api/interludios", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!data.ok) {
            return {
              content: [{ type: "text", text: data.error || "Error creating interludio" }],
              isError: true,
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(data.data, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
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
      "Obtener una playlist con su ID y el contenido formateado. workflow: 1) crear o listar playlist → obtener ID 2) obtener contenido con este tool",
      {
        id: z.string().describe("ID de la playlist"),
      },
      async ({ id }) => {
        const playlist = this.playlistRepo.get(id);
        if (!playlist)
          return { content: [{ type: "text", text: "Playlist no encontrada" }], isError: true };
        const tracks = playlist.tracks.map((t) => {
          if (t.type === "interludio") {
            return {
              type: "interludio",
              script: t.script ? t.script.slice(0, 100) : undefined,
            };
          }
          return {
            type: "song",
            title: t.title,
            artist: t.artist || "",
          };
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { id: playlist.id, name: playlist.name, tracks, total: tracks.length },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_playlist_create",
      "Crear una nueva playlist vacía. Devuelve el ID para usarlo luego en radio_playlist_add_track",
      {
        name: z.string().describe("Nombre de la playlist"),
      },
      async ({ name }) => {
        const playlist = this.playlistRepo.create(name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ id: playlist.id, name: playlist.name, tracks: [] }, null, 2),
            },
          ],
        };
      }
    );

    server.tool(
      "radio_playlist_add_track",
      "Añadir una o varias canciones/interludios a una playlist. Para añadir varios, usa tracks[]. Para interludios con script (TTS), incluye type:'interludio', title y script. workflow recomendado: 1) crear interludios con radio_interludio_create 2) añadirlos con tracks[] usando su id",
      {
        playlistId: z.string().describe("ID de la playlist"),
        libraryTrackId: z
          .string()
          .optional()
          .describe(
            "ID del track en la biblioteca (rellena automáticamente title, artist, file, duration)"
          ),
        id: z
          .string()
          .optional()
          .describe("ID del track en la biblioteca (alias de libraryTrackId)"),
        title: z.string().optional().describe("Título (obligatorio si no se usa libraryTrackId)"),
        artist: z.string().optional().describe("Artista"),
        file: z
          .string()
          .optional()
          .describe("Ruta del archivo relativa (ej: 'songs/mi-tema.mp3' o 'interludios/cuna.wav')"),
        duration: z.number().int().optional().default(0).describe("Duración en segundos"),
        type: z.enum(["song", "interludio"]).optional().default("song").describe("Tipo de track"),
        script: z.string().optional().describe("Texto TTS para interludios sintetizados"),
        tracks: z
          .array(
            z.object({
              libraryTrackId: z.string().optional().describe("ID del track en la biblioteca"),
              id: z.string().optional().describe("ID del track en la biblioteca (alias)"),
              title: z.string().optional().describe("Título del track"),
              artist: z.string().optional().describe("Artista"),
              file: z.string().optional().describe("Ruta del archivo relativa"),
              duration: z.number().int().optional().describe("Duración en segundos"),
              type: z.enum(["song", "interludio"]).optional().default("song").describe("Tipo"),
              script: z.string().optional().describe("Texto TTS para interludios"),
              position: z.number().int().optional().describe("Posición en la playlist"),
            })
          )
          .optional()
          .describe(
            "Array de tracks para añadir múltiples a la vez. Cada track puede tener libraryTrackId, id, o title+script"
          ),
      },
      async ({
        playlistId,
        libraryTrackId,
        id,
        title,
        artist,
        file,
        duration,
        type,
        script,
        tracks,
      }) => {
        // If tracks array provided, do batch add
        if (tracks && tracks.length > 0) {
          const body = JSON.stringify({ tracks });
          const res = await fetch(`http://localhost:3000/api/playlists/${playlistId}/tracks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          const data = await res.json();
          if (!data.ok) {
            return {
              content: [{ type: "text", text: data.error || "Error adding tracks" }],
              isError: true,
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(data.data, null, 2) }] };
        }

        // Single track mode (original behavior)
        const effectiveLibId = libraryTrackId || id;
        let resolvedTitle = title || "";
        let resolvedArtist = artist || "";
        let resolvedFile = file || undefined;
        let resolvedDuration = duration || 0;
        let resolvedType = type || "song";
        const resolvedScript = script;

        if (effectiveLibId) {
          const libTrack = this.libraryRepo.getTrackById(effectiveLibId);
          if (!libTrack)
            return {
              content: [
                {
                  type: "text",
                  text: `Track con ID '${effectiveLibId}' no existe en la biblioteca`,
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
            content: [{ type: "text", text: "Se requiere 'title', 'id' o 'libraryTrackId'" }],
            isError: true,
          };
        }

        const track = this.playlistRepo.addTrack(playlistId, {
          type: resolvedType,
          file: resolvedFile,
          title: resolvedTitle,
          artist: resolvedArtist,
          duration: resolvedDuration,
          script: resolvedScript,
        });
        if (!track)
          return { content: [{ type: "text", text: "Playlist no encontrada" }], isError: true };
        return {
          content: [{ type: "text", text: JSON.stringify(track, null, 2) }],
        };
      }
    );

    server.tool(
      "radio_playlist_play",
      "Reproducir una playlist. mode='ahora' (default) limpia la cola actual y reproduce ya. mode='encolar' añade los tracks al final de lo que esté sonando",
      {
        id: z.string().describe("ID de la playlist"),
        mode: z
          .enum(["ahora", "encolar"])
          .optional()
          .default("ahora")
          .describe("'ahora' (default) limpia y reproduce, 'encolar' añade al final"),
      },
      async ({ id, mode }) => {
        try {
          const res = await fetch(`http://localhost:3000/api/playlists/${id}/play`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: mode || "ahora" }),
          });
          const data = await res.json();
          if (!data.ok) {
            return { content: [{ type: "text", text: data.error || "Error" }], isError: true };
          }
          return { content: [{ type: "text", text: JSON.stringify(data.data, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      }
    );
  }

  public async startStdioServer(): Promise<void> {
    const transport = new StdioTransport();
    await this.server.connect(transport);
    console.log("[McpService] MCP Stdio Server running.");
  }

  public async handleHttpRequest(req: Request): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");

    // Existing session — reuse transport
    if (sessionId && sessionId === this.currentSessionId && this.httpTransport) {
      return this.httpTransport.handleRequest(req);
    }

    // New session — create fresh transport
    const transport = new HttpTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        this.currentSessionId = sid;
      },
      onsessionclosed: () => {
        this.currentSessionId = null;
        this.httpTransport = null;
      },
    });

    // Close previous session if any
    if (this.httpTransport) {
      try {
        await this.httpTransport.close();
      } catch {}
    }

    // Reset server transport reference so connect() doesn't throw
    (this.server.server as any)._transport = undefined;

    this.httpTransport = transport;
    await this.server.connect(transport);
    return transport.handleRequest(req);
  }
}
