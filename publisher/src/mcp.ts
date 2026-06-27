import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "./webStandardStreamableHttp.js";
import { z } from "zod";
import { getStreamStatus, queuePush, queueList, queueRemove, queueInsert, queueClear, skipTrack, playFileNow } from "./liquidsoap";
import { listSongs, listSongsPage, listInterludios, listInterludiosPage } from "./library";
import { searchLibrary, getLibraryStats, listPlaylists, getPlaylist } from "./db";

const server = new McpServer({
  name: "radio-bloom",
  version: "1.0.0",
});

server.tool(
  "radio_status",
  "Estado actual del stream: qué está sonando, cola, etc.",
  {},
  async () => {
    try {
      const status = await getStreamStatus();
      const queue = await queueList();
      const stats = getLibraryStats();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status, queue, library: stats }, null, 2),
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
    limit: z.number().int().min(1).max(50).optional().default(10).describe("Número máximo de resultados (default: 10)"),
    offset: z.number().int().min(0).optional().default(0).describe("Desde qué posición empezar (default: 0)"),
  },
  async ({ query, limit, offset }) => {
    const { items, total } = searchLibrary(query, limit, offset);
    return {
      content: [
        {
          type: "text",
          text: total === 0
            ? "No se encontraron resultados"
            : JSON.stringify({ total, showing: items.length, offset, items: items.map((r) => ({ id: r.id, file: r.file, title: r.title, artist: r.artist, type: r.type, duration: r.duration })) }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "radio_queue_list",
  "Listar el contenido actual de la cola de reproducción",
  {
    limit: z.number().int().min(1).max(100).optional().default(5).describe("Número máximo de elementos a mostrar (default: 5, recomendado)"),
  },
  async ({ limit }) => {
    const queue = await queueList();
    const items = queue.slice(0, limit);
    return {
      content: [
        {
          type: "text",
          text: queue.length === 0
            ? "Cola vacía"
            : JSON.stringify({ total: queue.length, showing: items.length, items: items.map((q, i) => ({ position: i + 1, ...q })) }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "radio_queue_add",
  "Añadir una canción o interludio al final de la cola. Usa el campo 'file' que devuelve radio_search",
  {
    file: z.string().describe("Ruta del archivo (campo 'file' del track, ej: 'songs/mi-tema.mp3' o 'interludios/pausa.mp3')"),
  },
  async ({ file }) => {
    const filepath = `/music/${file}`;
    const rid = await queuePush(filepath);
    if (!rid) return { content: [{ type: "text", text: "Error al encolar" }], isError: true };
    const queue = await queueList();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, rid, queue: queue.map((q, i) => ({ position: i + 1, ...q })) }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "radio_queue_insert",
  "Insertar una canción o interludio en una posición específica de la cola. La posición 1 es la siguiente en reproducirse",
  {
    position: z.number().int().min(1).describe("Posición donde insertar (1 = siguiente en reproducirse)"),
    file: z.string().describe("Ruta del archivo (campo 'file' del track)"),
  },
  async ({ position, file }) => {
    const filepath = `/music/${file}`;
    const ok = await queueInsert(position - 1, filepath);
    if (!ok) return { content: [{ type: "text", text: "Error al insertar en cola" }], isError: true };
    const queue = await queueList();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, queue: queue.map((q, i) => ({ position: i + 1, ...q })) }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "radio_queue_remove",
  "Eliminar un elemento de la cola por su posición",
  {
    position: z.number().int().min(1).describe("Posición del elemento a eliminar (1 = el siguiente en reproducirse)"),
  },
  async ({ position }) => {
    const queue = await queueList();
    if (position > queue.length) {
      return { content: [{ type: "text", text: `Posición ${position} no existe, la cola tiene ${queue.length} elementos` }], isError: true };
    }
    const rid = queue[position - 1].rid;
    const ok = await queueRemove(rid);
    if (!ok) return { content: [{ type: "text", text: "Error al eliminar" }], isError: true };
    const newQueue = await queueList();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, removed: position, queue: newQueue.map((q, i) => ({ position: i + 1, ...q })) }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "radio_queue_clear",
  "Vaciar toda la cola de reproducción",
  {},
  async () => {
    await queueClear();
    return { content: [{ type: "text", text: "Cola vaciada" }] };
  }
);

server.tool(
  "radio_play_now",
  "Reproducir una canción o interludio inmediatamente (limpia la cola y la salta)",
  {
    file: z.string().describe("Ruta del archivo (campo 'file' del track)"),
  },
  async ({ file }) => {
    const filepath = `/music/${file}`;
    const ok = await playFileNow(filepath);
    if (!ok) return { content: [{ type: "text", text: "Error al reproducir" }], isError: true };
    return { content: [{ type: "text", text: `Reproduciendo: ${file}` }] };
  }
);

server.tool(
  "radio_skip",
  "Saltar a la siguiente canción en la cola",
  {},
  async () => {
    await skipTrack();
    return { content: [{ type: "text", text: "Skip ejecutado" }] };
  }
);

server.tool(
  "radio_library_stats",
  "Estadísticas de la biblioteca: total de canciones e interludios",
  {},
  async () => {
    const stats = getLibraryStats();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "radio_list_songs",
  "Listar canciones de la biblioteca. Usa limit y offset para paginar (default: 5)",
  {
    limit: z.number().int().min(1).max(100).optional().default(5).describe("Número máximo de canciones (default: 5, recomendado)"),
    offset: z.number().int().min(0).optional().default(0).describe("Desde qué posición empezar (default: 0)"),
  },
  async ({ limit, offset }) => {
    const { items, total } = listSongsPage(limit, offset);
    return {
      content: [
        {
          type: "text",
          text: total === 0
            ? "No hay canciones"
            : JSON.stringify({ total, showing: items.length, offset, items: items.map((s) => ({ file: s.file, title: s.title, artist: s.artist, duration: s.duration })) }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "radio_list_interludios",
  "Listar interludios de la biblioteca. Usa limit y offset para paginar (default: 5)",
  {
    limit: z.number().int().min(1).max(100).optional().default(5).describe("Número máximo de interludios (default: 5, recomendado)"),
    offset: z.number().int().min(0).optional().default(0).describe("Desde qué posición empezar (default: 0)"),
  },
  async ({ limit, offset }) => {
    const { items, total } = listInterludiosPage(limit, offset);
    return {
      content: [
        {
          type: "text",
          text: total === 0
            ? "No hay interludios"
            : JSON.stringify({ total, showing: items.length, offset, items: items.map((i) => ({ file: i.file, title: i.title, duration: i.duration })) }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "radio_playlist_list",
  "Listar todas las playlists guardadas",
  {},
  async () => {
    const playlists = listPlaylists();
    return {
      content: [
        {
          type: "text",
          text: playlists.length === 0
            ? "No hay playlists"
            : JSON.stringify(playlists.map((p) => ({ id: p.id, name: p.name, tracks: p.tracks.length, updatedAt: p.updatedAt })), null, 2),
        },
      ],
    };
  }
);

server.tool(
  "radio_playlist_get",
  "Obtener una playlist con todas sus canciones e interludios",
  {
    id: z.string().describe("ID de la playlist"),
  },
  async ({ id }) => {
    const playlist = getPlaylist(id);
    if (!playlist) return { content: [{ type: "text", text: "Playlist no encontrada" }], isError: true };
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

export { server };

let httpTransport: WebStandardStreamableHTTPServerTransport | null = null;

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function createHttpTransport() {
  httpTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });
  server.connect(httpTransport);
  return httpTransport;
}

export function getHttpTransport() {
  return httpTransport;
}

if (import.meta.main) {
  startMcpServer().catch((err) => {
    console.error("[mcp] Fatal:", err);
    process.exit(1);
  });
}
