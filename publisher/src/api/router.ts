import { join } from "node:path";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import type { Track } from "../domain/types";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlaylistRepository } from "../repositories/sqlite/playlist.repo";
import type { ConfigService } from "../services/config.service";
import type { LibraryService } from "../services/library.service";
import type { LiquidsoapService } from "../services/liquidsoap.service";
import type { LiquidsoapQueueService } from "../services/liquidsoap-queue.service";
import type { LocutorService } from "../services/locutor.service";
import type { McpService } from "../services/mcp.service";
import type { TorrentService } from "../services/torrent.service";
import type { TtsService } from "../services/tts.service";

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return "never";
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, maxPerMinute = 120): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  entry.count++;
  return entry.count <= maxPerMinute;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300000);

interface FileTreeNode {
  name: string;
  path: string;
  children?: FileTreeNode[];
  tracks?: Track[];
}

function buildFileTree(tracks: Track[], rootName: string): FileTreeNode {
  const root: FileTreeNode = { name: rootName, path: "", children: [] };
  const prefix = rootName + "/";

  for (const track of tracks) {
    const relativePath = track.file.startsWith(prefix)
      ? track.file.slice(prefix.length)
      : track.file;
    const parts = relativePath.split("/");
    let current = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i];
      let child = current.children?.find((c) => c.name === folderName);
      if (!child) {
        child = {
          name: folderName,
          path: parts.slice(0, i + 1).join("/"),
          children: [],
        };
        current.children!.push(child);
      }
      current = child;
    }

    if (!current.tracks) current.tracks = [];
    current.tracks.push(track);
  }

  return compressFileTree(root);
}

function compressFileTree(node: FileTreeNode): FileTreeNode {
  const result: FileTreeNode = { name: node.name, path: node.path };
  if (node.tracks) result.tracks = node.tracks;
  if (node.children && node.children.length > 0) {
    result.children = node.children.map(compressFileTree);
  }
  return result;
}

export interface ApiDependencies {
  configService: ConfigService;
  libraryRepo: LibraryRepository;
  libraryService: LibraryService;
  liquidsoapService: LiquidsoapService;
  liquidsoapQueueService: LiquidsoapQueueService;
  playlistRepo: PlaylistRepository;
  locutorService: LocutorService;
  mcpService: McpService;
  torrentService: TorrentService;
  musicDir: string;
  distDir: string;
  ttsService: TtsService;
}

export function createApiRouter(deps: ApiDependencies): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    })
  );

  app.use("*", async (c: any, next: any) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    if (!checkRateLimit(ip)) {
      return c.json({ ok: false, error: "Rate limit exceeded" }, 429);
    }
    await next();
  });

  // ============================================================
  // SYSTEM
  // ============================================================

  app.get("/api/system/status", async (c) => {
    const liquidsoapConnected = deps.liquidsoapService.isConnected();
    const config = deps.configService.get();
    return c.json({
      ok: true,
      data: {
        liquidsoap: {
          connected: liquidsoapConnected,
          telnetPort: parseInt(process.env.LIQUIDSOAP_TELNET_PORT || "1234", 10),
          harbourPort: parseInt(process.env.LIQUIDSOAP_HARBOUR_PORT || "8000", 10),
          streamUrl: `http://localhost:${process.env.LIQUIDSOAP_HARBOUR_PORT || "8000"}/radiobloom.mp3`,
        },
        config,
      },
    });
  });

  app.get("/api/system/config", (c) => {
    return c.json({ ok: true, data: deps.configService.get() });
  });

  app.put("/api/system/config", async (c) => {
    const body = await c.req.json();
    const config = deps.configService.update(body);
    return c.json({ ok: true, data: config });
  });

  // ============================================================
  // LIBRARY
  // ============================================================

  app.get("/api/library", (c) => {
    const songs = deps.libraryService.listSongs();
    const interludios = deps.libraryService.listInterludios();
    return c.json({ ok: true, data: { songs, interludios } });
  });

  app.get("/api/library/songs", (c) => {
    return c.json({ ok: true, data: deps.libraryService.listSongs() });
  });

  app.get("/api/library/interludios", (c) => {
    return c.json({ ok: true, data: deps.libraryService.listInterludios() });
  });

  app.get("/api/library/track/:id", (c) => {
    const id = c.req.param("id");
    const track = deps.libraryService.getTrackById(id);
    if (!track) return c.json({ ok: false, error: "Track not found" }, 404);
    return c.json({ ok: true, data: track });
  });

  app.delete("/api/library/track/:id", (c) => {
    const id = c.req.param("id");
    const track = deps.libraryService.getTrackById(id);
    if (!track) return c.json({ ok: false, error: "Track not found" }, 404);
    const deleted = deps.libraryService.deleteTrack(track.file);
    if (!deleted) return c.json({ ok: false, error: "Could not delete" }, 500);
    return c.json({ ok: true, data: { deleted: id } });
  });

  app.get("/api/library/rescan", async (c) => {
    try {
      await deps.libraryService.rescan();
      return c.json({ ok: true, data: { rescanned: true } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.get("/api/library/search", (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ ok: false, error: "q query param required" }, 400);
    const results = deps.libraryRepo.search(q);
    const items = results.items.map(
      ({ addedAt, mtime, file, duration, lastPlayedAt, ...rest }) => ({
        ...rest,
        duration: duration ? formatDuration(duration) : "00:00:00",
        lastPlayedAt: timeAgo(lastPlayedAt || ""),
      })
    );
    return c.json({ ok: true, data: { items, total: results.total } });
  });

  // Upload file to library
  app.post("/api/library/upload", async (c) => {
    try {
      const formData = await c.req.formData();
      const fileField = formData.get("file");
      if (!fileField || !(fileField instanceof File)) {
        return c.json({ ok: false, error: "Se requiere un archivo en el campo 'file'" }, 400);
      }
      if (fileField.size > MAX_UPLOAD_BYTES) {
        return c.json(
          { ok: false, error: `Archivo excede el límite de ${MAX_UPLOAD_BYTES / 1024 / 1024}MB` },
          413
        );
      }
      const type = (formData.get("type") as string) || "song";
      if (type !== "song" && type !== "interludio") {
        return c.json({ ok: false, error: "type debe ser 'song' o 'interludio'" }, 400);
      }
      const targetDir =
        type === "song" ? join(deps.musicDir, "songs") : join(deps.musicDir, "interludios");
      const fileName = fileField.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = join(targetDir, fileName);
      const buffer = await fileField.arrayBuffer();
      await Bun.write(filePath, new Uint8Array(buffer));
      console.log(`[Upload] File saved: ${filePath}`);
      return c.json({ ok: true, data: { fileName, type } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.post("/api/library/:id/play", async (c) => {
    const id = c.req.param("id");
    const allTracks = [
      ...deps.libraryService.listSongs(),
      ...deps.libraryService.listInterludios(),
    ];
    const track = allTracks.find((t) => t.id === id);
    if (!track) return c.json({ ok: false, error: "Track not found" }, 404);

    const filepath = `/music/${track.file}`;
    const ok = await deps.liquidsoapService.playFileNow(filepath);
    if (!ok) return c.json({ ok: false, error: "Failed to play track" }, 500);
    return c.json({ ok: true, data: { action: "play", track } });
  });

  app.get("/api/library/tree", (c) => {
    const songs = deps.libraryService.listSongs();
    const interludios = deps.libraryService.listInterludios();
    return c.json({
      ok: true,
      data: {
        songs: buildFileTree(songs, "songs"),
        interludios: buildFileTree(interludios, "interludios"),
      },
    });
  });

  // ============================================================
  // STREAM CONTROL (Liquidsoap)
  // ============================================================

  app.get("/api/stream", async (c) => {
    const track = await deps.liquidsoapService.getCurrentTrack();

    if (!track) {
      return c.json({ ok: true, data: null });
    }

    return c.json({
      ok: true,
      data: track,
    });
  });

  app.post("/api/stream/play", async (c) => {
    try {
      await deps.liquidsoapService.startPlayback();
      return c.json({ ok: true, data: { action: "play" } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.post("/api/stream/pause", async (c) => {
    try {
      await deps.liquidsoapService.pausePlayback();
      return c.json({ ok: true, data: { action: "pause" } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  const handleSkip = async (c: any) => {
    try {
      await deps.liquidsoapService.skipTrack();
      await new Promise((r) => setTimeout(r, 500));
      const status = await deps.liquidsoapService.getStreamStatus();
      return c.json({ ok: true, data: { action: "skip", nowPlaying: status } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  };

  app.get("/api/stream/skip", handleSkip);
  app.post("/api/stream/skip", handleSkip);

  app.post("/api/stream/reload", async (c) => {
    try {
      await deps.liquidsoapService.reloadPlaylist();
      return c.json({ ok: true, data: { action: "reload" } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  // Queue tracks or synthesize TTS interludios (via BullMQ)
  app.post("/api/stream/queue", async (c) => {
    try {
      const body = await c.req.json();
      const items = Array.isArray(body) ? body : [body];
      const results: { jobId: string; type: string }[] = [];

      for (const item of items) {
        const { id, script, voice } = item;

        if (id) {
          const track = deps.libraryRepo.getTrackById(id);
          if (!track) {
            return c.json({ ok: false, error: `Track not found: ${id}` }, 400);
          }
          const filepath = `/music/${track.file}`;
          const job = await deps.liquidsoapQueueService.add(filepath);
          results.push({ jobId: job.id!, type: track.type });
        } else if (script) {
          const job = await deps.liquidsoapQueueService.addTts(script, voice);
          results.push({ jobId: job.id!, type: "interludio" });
        }
      }

      return c.json({ ok: true, data: results });
    } catch (err: any) {
      return c.json(
        { ok: false, error: err.message, stack: err.stack?.split("\n").slice(0, 5).join("\\n") },
        500
      );
    }
  });

  app.get("/api/stream/queue", async (c) => {
    try {
      const { items } = await deps.liquidsoapService.queueList();
      const clean = items.map(({ file, ...rest }) => rest);
      return c.json({ ok: true, data: clean });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.delete("/api/stream/queue", async (c) => {
    try {
      await deps.liquidsoapService.queueClear();
      return c.json({ ok: true, data: { cleared: true } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.delete("/api/stream/queue/:rid", async (c) => {
    try {
      const rid = c.req.param("rid");
      const ok = await deps.liquidsoapService.queueRemove(rid);
      if (!ok) {
        return c.json(
          { ok: false, error: "RID not found in queue (ya pasó a reproducción o no existe)" },
          404
        );
      }
      const { items: list } = await deps.liquidsoapService.queueList();
      return c.json({ ok: true, data: { removed: rid, queue: list } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.post("/api/stream/queue/insert", async (c) => {
    try {
      const body = await c.req.json();
      const { index, id } = body;
      if (typeof index !== "number" || !id) {
        return c.json({ ok: false, error: "index and id (track ID) are required" }, 400);
      }

      const track = deps.libraryRepo.getTrackById(id);
      if (!track) return c.json({ ok: false, error: "Track no encontrado" }, 404);

      const ok = await deps.liquidsoapService.queueInsert(index, `/music/${track.file}`);
      if (!ok) return c.json({ ok: false, error: "Failed to insert" }, 500);
      const { items: list } = await deps.liquidsoapService.queueList();
      return c.json({ ok: true, data: { index, track, queue: list } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  // ============================================================
  // INTERLUDIOS (TTS Creation)
  // ============================================================

  app.post("/api/interludios", async (c) => {
    try {
      const body = await c.req.json();
      if (!body.script) return c.json({ ok: false, error: "script is required" }, 400);

      const title = body.title || body.script.slice(0, 60);
      const voice = body.voice || process.env.AI_DJ_VOICE || "es-ES-AlvaroNeural";

      const { EdgeTTS } = await import("edge-tts-universal");
      const { promises: fsPromises } = await import("node:fs");
      const { join } = await import("node:path");

      const filename = `ai_dj_pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`;
      const subdir = join(deps.musicDir, "interludios");
      const filePath = join(subdir, filename);

      const tts = new EdgeTTS(body.script, voice);
      const result = await tts.synthesize();
      const arrayBuffer = await result.audio.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await fsPromises.writeFile(filePath, buffer);

      const stats = await fsPromises.stat(filePath);
      const relativePath = `interludios/${filename}`;

      let duration = 0;
      try {
        const { AudioMetadataClient } = await import("../infrastructure/audio-metadata.client");
        const meta = await new AudioMetadataClient().extractMetadata(filePath);
        duration = meta.duration || 0;
      } catch {}

      deps.libraryRepo.upsertTtsInterludio(relativePath, body.script, duration, stats.size);
      await deps.libraryService.rescan();

      const track = deps.libraryRepo.getTrackByFile(relativePath);

      return c.json({ ok: true, data: track });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  // ============================================================
  // PLAYLISTS
  // ============================================================

  app.post("/api/playlists", async (c) => {
    const body = await c.req.json();
    if (!body.name) return c.json({ ok: false, error: "name is required" }, 400);
    const playlist = deps.playlistRepo.create(body.name, {
      description: body.description,
      locutorId: body.locutorId,
    });
    return c.json({ ok: true, data: playlist });
  });

  app.get("/api/playlists", (c) => {
    return c.json({ ok: true, data: deps.playlistRepo.list() });
  });

  app.get("/api/playlists/:id", (c) => {
    const playlist = deps.playlistRepo.get(c.req.param("id"));
    if (!playlist) return c.json({ ok: false, error: "Playlist not found" }, 404);
    return c.json({ ok: true, data: playlist });
  });

  app.put("/api/playlists/:id", async (c) => {
    const body = await c.req.json();
    const updates: Record<string, any> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.played !== undefined) updates.played = body.played;

    const id = c.req.param("id");

    // Update name/played via generic update
    if (body.name !== undefined || body.played !== undefined) {
      const updates: { name?: string; played?: boolean } = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.played !== undefined) updates.played = body.played;
      deps.playlistRepo.update(id, updates);
    }

    // Update locutorId and/or description
    if (body.locutorId !== undefined || body.description !== undefined) {
      deps.playlistRepo.updateLocutorAndDescription(id, {
        locutorId: body.locutorId,
        description: body.description,
      });
    }

    const playlist = deps.playlistRepo.get(id);
    if (!playlist) return c.json({ ok: false, error: "Playlist not found" }, 404);
    return c.json({ ok: true, data: playlist });
  });

  app.delete("/api/playlists/:id", (c) => {
    const ok = deps.playlistRepo.delete(c.req.param("id"));
    if (!ok) return c.json({ ok: false, error: "Playlist not found" }, 404);
    return c.json({ ok: true, data: { deleted: c.req.param("id") } });
  });

  // Batch add multiple tracks at once
  app.post("/api/playlists/:id/tracks", async (c) => {
    const body = await c.req.json();
    const items = Array.isArray(body) ? body : body.tracks;
    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ ok: false, error: "tracks array is required" }, 400);
    }

    const playlistId = c.req.param("id");
    const results: { index: number; status: string; track?: any; error?: string }[] = [];

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      try {
        const type = item.type || "song";
        if (type !== "song" && type !== "interludio") {
          results.push({
            index: idx,
            status: "failed",
            error: "type must be 'song' or 'interludio'",
          });
          continue;
        }

        const libId = item.libraryTrackId || item.id;
        if (libId) {
          const libTrack = deps.libraryRepo.getTrackById(libId);
          if (!libTrack) {
            results.push({ index: idx, status: "failed", error: `Track not found: ${libId}` });
            continue;
          }
          const track = deps.playlistRepo.addTrack(
            playlistId,
            {
              type: libTrack.type as "song" | "interludio",
              file: libTrack.file,
              title: libTrack.title,
              artist: libTrack.artist,
              duration: libTrack.duration,
              spotifyUrl: libTrack.spotifyUrl,
              script: item.script,
            },
            item.position
          );
          if (!track) {
            results.push({ index: idx, status: "failed", error: "Playlist not found" });
            continue;
          }
          results.push({ index: idx, status: "added", track });
          continue;
        }

        if (!item.title) {
          results.push({ index: idx, status: "failed", error: "title is required" });
          continue;
        }
        if (type === "interludio" && !item.file && !item.script) {
          results.push({
            index: idx,
            status: "failed",
            error: "interludio must have file or script",
          });
          continue;
        }

        const track = deps.playlistRepo.addTrack(
          playlistId,
          {
            type: type as "song" | "interludio",
            file: item.file,
            title: item.title,
            artist: item.artist,
            duration: item.duration || 0,
            spotifyUrl: item.spotifyUrl,
            script: item.script,
          },
          item.position
        );
        if (!track) {
          results.push({ index: idx, status: "failed", error: "Playlist not found" });
          continue;
        }
        results.push({ index: idx, status: "added", track });
      } catch (err: any) {
        results.push({ index: idx, status: "failed", error: err.message });
      }
    }

    return c.json({
      ok: true,
      data: {
        playlistId,
        total: items.length,
        added: results.filter((r) => r.status === "added").length,
        failed: results.filter((r) => r.status === "failed").length,
        results,
      },
    });
  });

  app.put("/api/playlists/:id/tracks/reorder", async (c) => {
    const body = await c.req.json();
    if (!body.trackIds || !Array.isArray(body.trackIds)) {
      return c.json({ ok: false, error: "trackIds array is required" }, 400);
    }
    deps.playlistRepo.reorderTracks(c.req.param("id"), body.trackIds);
    return c.json({ ok: true, data: deps.playlistRepo.get(c.req.param("id")) });
  });

  app.put("/api/playlists/:id/tracks/:trackId", async (c) => {
    const body = await c.req.json();
    const updates: Record<string, any> = {};
    if (body.type !== undefined) updates.type = body.type;
    if (body.title !== undefined) updates.title = body.title;
    if (body.artist !== undefined) updates.artist = body.artist;
    if (body.duration !== undefined) updates.duration = body.duration;
    if (body.script !== undefined) updates.script = body.script;
    if (Object.keys(updates).length === 0) {
      return c.json({ ok: false, error: "No fields to update" }, 400);
    }
    const track = deps.playlistRepo.updateTrack(c.req.param("id"), c.req.param("trackId"), updates);
    if (!track) return c.json({ ok: false, error: "Track not found" }, 404);
    return c.json({ ok: true, data: track });
  });

  app.delete("/api/playlists/:id/tracks/:trackId", (c) => {
    const ok = deps.playlistRepo.removeTrack(c.req.param("id"), c.req.param("trackId"));
    if (!ok) return c.json({ ok: false, error: "Track not found" }, 404);
    return c.json({ ok: true, data: { removed: c.req.param("trackId") } });
  });

  app.post("/api/playlists/:id/play", async (c) => {
    const playlist = deps.playlistRepo.get(c.req.param("id"));
    if (!playlist) return c.json({ ok: false, error: "Playlist not found" }, 404);
    if (playlist.tracks.length === 0) return c.json({ ok: false, error: "Playlist is empty" }, 400);

    const body = await c.req.json().catch(() => ({}));
    const mode = body?.mode || "ahora";
    const voice = body?.voice;
    const force = body?.force === true;

    if (playlist.played && !force) {
      return c.json({ ok: false, error: "Playlist has already been played" }, 400);
    }

    // Mark as played immediately
    deps.playlistRepo.update(playlist.id, { played: true });

    if (mode === "ahora") {
      await deps.liquidsoapService.queueClear().catch(() => {});
    }

    const tracks = [...playlist.tracks];
    const results: {
      pos: number;
      title: string;
      status: string;
      jobId?: string;
      error?: string;
    }[] = [];

    for (const track of tracks) {
      try {
        if (track.script && !track.file) {
          const job = await deps.liquidsoapQueueService.addTts(track.script, voice);
          results.push({ pos: track.pos, title: track.title, status: "queued", jobId: job.id! });
        } else if (track.file) {
          const filepath = `/music/${track.file}`;
          const job = await deps.liquidsoapQueueService.add(filepath);
          results.push({ pos: track.pos, title: track.title, status: "queued", jobId: job.id! });
        } else {
          results.push({
            pos: track.pos,
            title: track.title,
            status: "skipped",
            error: "no file or script",
          });
        }
      } catch (err: any) {
        results.push({ pos: track.pos, title: track.title, status: "failed", error: err.message });
      }
    }

    return c.json({
      ok: true,
      data: {
        playlistId: playlist.id,
        name: playlist.name,
        mode,
        total: tracks.length,
        queued: results.filter((r) => r.status === "queued").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length,
        results,
      },
    });
  });

  // ============================================================
  // LOCUTORS (AI Announcers)
  // ============================================================

  app.get("/api/locutors", (c) => {
    const locutors = deps.locutorService.listLocutors();
    const schedules = deps.locutorService.listSchedules();

    const data = locutors.map((l) => ({
      ...l,
      schedules: schedules.filter((s) => s.locutorId === l.id),
    }));

    return c.json({ ok: true, data });
  });

  app.post("/api/locutors", async (c) => {
    try {
      const body = await c.req.json();
      if (!body.name || !body.voice || !body.personality) {
        return c.json({ ok: false, error: "name, voice, and personality are required" }, 400);
      }
      const locutor = deps.locutorService.createLocutor({
        name: body.name,
        voice: body.voice,
        personality: body.personality,
        isActive: body.isActive ?? true,
        isDefault: body.isDefault ?? false,
      });
      return c.json({ ok: true, data: locutor });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.put("/api/locutors/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const body = await c.req.json();
      const locutor = deps.locutorService.updateLocutor(id, body);
      if (!locutor) return c.json({ ok: false, error: "Locutor not found" }, 404);
      return c.json({ ok: true, data: locutor });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 400);
    }
  });

  app.delete("/api/locutors/:id", (c) => {
    const id = c.req.param("id");
    const ok = deps.locutorService.deleteLocutor(id);
    if (!ok) return c.json({ ok: false, error: "Locutor not found" }, 404);
    return c.json({ ok: true, data: { deleted: id } });
  });

  app.post("/api/locutors/:id/schedules", async (c) => {
    try {
      const id = c.req.param("id");
      const body = await c.req.json();
      if (!body.type || !body.startHour || typeof body.duration !== "number") {
        return c.json(
          { ok: false, error: "type, startHour, and duration (number) are required" },
          400
        );
      }
      const schedule = deps.locutorService.createSchedule({
        locutorId: id,
        type: body.type,
        dayOfWeek: body.dayOfWeek !== undefined ? body.dayOfWeek : null,
        startHour: body.startHour,
        duration: body.duration,
      });
      return c.json({ ok: true, data: schedule });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 400);
    }
  });

  app.delete("/api/locutors/:id/schedules/:scheduleId", (c) => {
    const scheduleId = c.req.param("scheduleId");
    const ok = deps.locutorService.deleteSchedule(scheduleId);
    if (!ok) return c.json({ ok: false, error: "Schedule not found" }, 404);
    return c.json({ ok: true, data: { deleted: scheduleId } });
  });

  // Bull-Board Queue Panel
  const serverAdapter = new HonoAdapter(serveStatic);
  createBullBoard({
    queues: [
      new BullMQAdapter(deps.torrentService.getQueue()),
      new BullMQAdapter(deps.liquidsoapQueueService.getQueue()),
    ],
    serverAdapter: serverAdapter,
  });
  serverAdapter.setBasePath("/admin/queues");
  (app as any).route("/admin/queues", serverAdapter.registerPlugin());

  // ============================================================
  // TORRENTS
  // ============================================================

  app.get("/api/torrents/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ ok: false, error: "q parameter is required" }, 400);
    const limitStr = c.req.query("limit");
    const limit = limitStr ? parseInt(limitStr, 10) : 10;
    const results = await deps.torrentService.search(q, limit);
    return c.json({ ok: true, data: results });
  });

  app.post("/api/torrents/queue", async (c) => {
    try {
      const body = await c.req.json();
      const { magnet, name } = body;
      if (!magnet || !name) {
        return c.json({ ok: false, error: "magnet and name are required" }, 400);
      }
      const job = await deps.torrentService.queueDownload(magnet, name);
      return c.json({
        ok: true,
        data: {
          jobId: job.id,
          name: job.name,
          status: await job.getState(),
        },
      });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.get("/api/torrents/jobs", async (c) => {
    try {
      const limitStr = c.req.query("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : 20;
      const jobs = await deps.torrentService.listJobs(limit);
      const stats = await deps.torrentService.getQueueStats();
      return c.json({ ok: true, data: { jobs, stats } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.get("/api/torrents/jobs/:id/logs", async (c) => {
    try {
      const id = c.req.param("id");
      const logs = await deps.torrentService.getJobLogs(id);
      return c.json({ ok: true, data: logs });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.post("/api/torrents/jobs/:id/cancel", async (c) => {
    try {
      const id = c.req.param("id");
      const cancelled = await deps.torrentService.cancelJob(id);
      return c.json({ ok: true, data: { cancelled } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  // ============================================================
  // HEALTH
  // ============================================================

  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      data: {
        status: "running",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      },
    });
  });

  // ============================================================
  // MCP (Model Context Protocol) over HTTP
  // ============================================================

  app.all("/mcp", async (c) => {
    try {
      const response = await deps.mcpService.handleHttpRequest(c.req.raw);
      return c.newResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // ============================================================
  // STATIC FILES (Astro Landing Page)
  // ============================================================

  // SPA fallback: admin client-side routing -> serve admin/index.html
  app.use(
    "/admin/*",
    serveStatic({
      root: deps.distDir,
      rewriteRequestPath: (p) => {
        if (p.startsWith("/admin/queues")) return p;
        return "/admin/index.html";
      },
    })
  );

  app.use(
    "/*",
    serveStatic({
      root: deps.distDir,
      rewriteRequestPath: (path) => {
        if (path === "/en" || path === "/en/") return "/en/index.html";
        return path;
      },
    })
  );

  return app;
}
