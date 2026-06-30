import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlaylistRepository } from "../repositories/sqlite/playlist.repo";
import type { ConfigService } from "../services/config.service";
import type { LibraryService } from "../services/library.service";
import type { LiquidsoapService } from "../services/liquidsoap.service";
import type { LocutorService } from "../services/locutor.service";
import type { McpService } from "../services/mcp.service";
import type { TorrentService } from "../services/torrent.service";

export interface ApiDependencies {
  configService: ConfigService;
  libraryRepo: LibraryRepository;
  libraryService: LibraryService;
  liquidsoapService: LiquidsoapService;
  playlistRepo: PlaylistRepository;
  locutorService: LocutorService;
  mcpService: McpService;
  torrentService: TorrentService;
  musicDir: string;
  distDir: string;
}

export function createApiRouter(deps: ApiDependencies): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    })
  );

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
    return c.json({ ok: true, data: results });
  });

  // Upload file to library
  app.post("/api/library/upload", async (c) => {
    try {
      const formData = await c.req.formData();
      const fileField = formData.get("file");
      if (!fileField || !(fileField instanceof File)) {
        return c.json({ ok: false, error: "Se requiere un archivo en el campo 'file'" }, 400);
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

  // ============================================================
  // STREAM CONTROL (Liquidsoap)
  // ============================================================

  app.get("/api/stream", async (c) => {
    const status = await deps.liquidsoapService.getStreamStatus();
    return c.json({ ok: true, data: status });
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

  // Queue a track by its library ID
  app.post("/api/stream/queue", async (c) => {
    try {
      const body = await c.req.json();
      const { id } = body;
      if (!id) return c.json({ ok: false, error: "id (track ID) is required" }, 400);

      const track = deps.libraryRepo.getTrackById(id);
      if (!track) return c.json({ ok: false, error: "Track no encontrado en la biblioteca" }, 404);

      const filepath = `/music/${track.file}`;
      const rid = await deps.liquidsoapService.queuePush(filepath);
      const list = await deps.liquidsoapService.queueList();
      return c.json({ ok: true, data: { source: "library", rid, track, queue: list } });
    } catch (err: any) {
      return c.json(
        { ok: false, error: err.message, stack: err.stack?.split("\n").slice(0, 5).join("\\n") },
        500
      );
    }
  });

  app.get("/api/stream/queue", async (c) => {
    try {
      const items = await deps.liquidsoapService.queueList();
      return c.json({ ok: true, data: items });
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
      const list = await deps.liquidsoapService.queueList();
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
      const list = await deps.liquidsoapService.queueList();
      return c.json({ ok: true, data: { index, track, queue: list } });
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
    const playlist = deps.playlistRepo.create(body.name);
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
    if (!body.name) return c.json({ ok: false, error: "name is required" }, 400);
    const ok = deps.playlistRepo.updateName(c.req.param("id"), body.name);
    if (!ok) return c.json({ ok: false, error: "Playlist not found" }, 404);
    return c.json({ ok: true, data: deps.playlistRepo.get(c.req.param("id")) });
  });

  app.delete("/api/playlists/:id", (c) => {
    const ok = deps.playlistRepo.delete(c.req.param("id"));
    if (!ok) return c.json({ ok: false, error: "Playlist not found" }, 404);
    return c.json({ ok: true, data: { deleted: c.req.param("id") } });
  });

  app.post("/api/playlists/:id/tracks", async (c) => {
    const body = await c.req.json();
    if (!body.title) return c.json({ ok: false, error: "title is required" }, 400);
    const track = deps.playlistRepo.addTrack(
      c.req.param("id"),
      {
        type: body.type || "song",
        file: body.file,
        title: body.title,
        artist: body.artist,
        duration: body.duration || 0,
      },
      body.position
    );
    if (!track) return c.json({ ok: false, error: "Playlist not found" }, 404);
    return c.json({ ok: true, data: track });
  });

  app.put("/api/playlists/:id/tracks/:trackId", async (c) => {
    const body = await c.req.json();
    const updates: Record<string, any> = {};
    if (body.type !== undefined) updates.type = body.type;
    if (body.title !== undefined) updates.title = body.title;
    if (body.artist !== undefined) updates.artist = body.artist;
    if (body.duration !== undefined) updates.duration = body.duration;
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

  app.put("/api/playlists/:id/tracks/reorder", async (c) => {
    const body = await c.req.json();
    if (!body.trackIds || !Array.isArray(body.trackIds)) {
      return c.json({ ok: false, error: "trackIds array is required" }, 400);
    }
    deps.playlistRepo.reorderTracks(c.req.param("id"), body.trackIds);
    return c.json({ ok: true, data: deps.playlistRepo.get(c.req.param("id")) });
  });

  app.post("/api/playlists/:id/play", async (c) => {
    const playlist = deps.playlistRepo.get(c.req.param("id"));
    if (!playlist) return c.json({ ok: false, error: "Playlist not found" }, 404);
    if (playlist.tracks.length === 0) return c.json({ ok: false, error: "Playlist is empty" }, 400);

    const body = await c.req.json().catch(() => ({}));
    const shuffle = body?.shuffle === true;

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
        filepaths.push(`/music/${track.file}`);
        results.push({ pos: track.pos, title: track.title, status: "queued" });
      } else {
        results.push({ pos: track.pos, title: track.title, status: "skipped: no file" });
      }
    }

    let firstPlayed = false;
    if (filepaths.length > 0) {
      firstPlayed = await deps.liquidsoapService.playFilesNow(filepaths);
    }

    return c.json({
      ok: true,
      data: {
        playlistId: playlist.id,
        name: playlist.name,
        shuffle,
        total: tracks.length,
        queued: filepaths.length,
        skipped: tracks.length - filepaths.length,
        firstPlayed,
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
    queues: [new BullMQAdapter(deps.torrentService.getQueue())],
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
