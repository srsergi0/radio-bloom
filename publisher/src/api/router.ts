import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlaylistRepository } from "../repositories/sqlite/playlist.repo";
import type { ConfigService } from "../services/config.service";
import type { DownloadService } from "../services/download.service";
import type { LibraryService } from "../services/library.service";
import type { LiquidsoapService } from "../services/liquidsoap.service";
import type { McpService } from "../services/mcp.service";

export interface ApiDependencies {
  configService: ConfigService;
  libraryRepo: LibraryRepository;
  libraryService: LibraryService;
  liquidsoapService: LiquidsoapService;
  downloadService: DownloadService;
  playlistRepo: PlaylistRepository;
  mcpService: McpService;
  musicDir: string;
  distDir: string;
}

export function createApiRouter(deps: ApiDependencies): Hono {
  const app = new Hono();

  // CORS middleware configuration
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

  app.post("/api/library/:id/play", async (c) => {
    const id = c.req.param("id");
    const allTracks = [
      ...deps.libraryService.listSongs(),
      ...deps.libraryService.listInterludios(),
    ];
    console.log("[library/play] id:", id, "total tracks:", allTracks.length);
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

  app.post("/api/stream/queue", async (c) => {
    try {
      const body = await c.req.json();
      const { url } = body;
      if (!url) return c.json({ ok: false, error: "url is required" }, 400);

      const existing = deps.libraryService.getTrackByUrl(url);
      if (!existing) {
        const job = await deps.downloadService.downloadFromSpotify(url, async (track) => {
          const filepath = `/music/${track.file}`;
          await deps.liquidsoapService.queuePush(filepath);
        });
        const list = await deps.liquidsoapService.queueList();
        return c.json({ ok: true, data: { source: "download", job, queue: list } });
      }

      const filepath = `/music/${existing.file}`;
      const rid = await deps.liquidsoapService.queuePush(filepath);
      const list = await deps.liquidsoapService.queueList();
      return c.json({ ok: true, data: { source: "library", rid, track: existing, queue: list } });
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
      const { index, url } = body;
      if (typeof index !== "number" || !url) {
        return c.json({ ok: false, error: "index and url are required" }, 400);
      }

      const existing = deps.libraryService.getTrackByUrl(url);
      if (existing) {
        const ok = await deps.liquidsoapService.queueInsert(index, `/music/${existing.file}`);
        if (!ok) return c.json({ ok: false, error: "Failed to insert" }, 500);
        const list = await deps.liquidsoapService.queueList();
        return c.json({ ok: true, data: { index, track: existing, queue: list } });
      }

      const job = await deps.downloadService.downloadFromSpotify(url, async (track) => {
        await deps.liquidsoapService.queueInsert(index, `/music/${track.file}`).catch(() => {});
      });
      return c.json({ ok: true, data: { source: "download", job } });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  app.post("/api/stream/play/url", async (c) => {
    try {
      const body = await c.req.json();
      const { url } = body;
      if (!url) return c.json({ ok: false, error: "url is required" }, 400);

      const existing = deps.libraryService.getTrackByUrl(url);
      if (existing) {
        const filepath = `/music/${existing.file}`;
        await deps.liquidsoapService.sendCommand("queue.flush_and_skip");
        await new Promise((r) => setTimeout(r, 500));
        const rid = await deps.liquidsoapService.queuePush(filepath);
        if (!rid) return c.json({ ok: false, error: "Failed to queue" }, 500);
        const st = await deps.liquidsoapService.getStreamStatus();
        const list = await deps.liquidsoapService.queueList();
        return c.json({
          ok: true,
          data: { source: "library", track: existing, nowPlaying: st, queue: list },
        });
      }

      const job = await deps.downloadService.downloadFromSpotify(url, async (track) => {
        const filepath = `/music/${track.file}`;
        await deps.liquidsoapService.sendCommand("queue.flush_and_skip").catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        await deps.liquidsoapService.queuePush(filepath).catch(() => {});
      });
      return c.json({ ok: true, data: { source: "download", job } });
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
        spotifyUrl: body.spotifyUrl,
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
    if (body.spotifyUrl !== undefined) updates.spotifyUrl = body.spotifyUrl;
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

  app.post("/api/playlists/:id/load", async (c) => {
    const playlist = deps.playlistRepo.get(c.req.param("id"));
    if (!playlist) return c.json({ ok: false, error: "Playlist not found" }, 404);

    const results: { title: string; status: string; error?: string }[] = [];
    const pending: { track: (typeof playlist.tracks)[0]; filepath: string }[] = [];

    for (const track of playlist.tracks) {
      const filepath = track.file ? join(deps.musicDir, track.file) : "";
      if (filepath && existsSync(filepath)) {
        const rid = await deps.liquidsoapService.queuePush(`/music/${track.file}`);
        results.push({ title: track.title, status: rid ? "queued" : "error" });
        continue;
      }
      if (track.spotifyUrl) {
        pending.push({ track, filepath });
      } else if (track.file) {
        results.push({ title: track.title, status: "error", error: "File not found" });
      }
    }

    // Fire all pending downloads asynchronously (queued when complete)
    for (const p of pending) {
      deps.downloadService
        .downloadFromSpotify(p.track.spotifyUrl!, async (downloaded) => {
          const rid = await deps.liquidsoapService.queuePush(`/music/${downloaded.file}`);
          results.push({ title: downloaded.title, status: rid ? "queued" : "error" });
        })
        .catch((err: any) => {
          results.push({ title: p.track.title, status: "error", error: err.message });
          return null;
        });
    }

    return c.json({ ok: true, data: { playlistId: playlist.id, results } });
  });

  app.post("/api/playlists/:id/play", async (c) => {
    const playlist = deps.playlistRepo.get(c.req.param("id"));
    if (!playlist) return c.json({ ok: false, error: "Playlist not found" }, 404);
    if (playlist.tracks.length === 0) {
      return c.json({ ok: false, error: "Playlist is empty" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const shuffle = body?.shuffle === true;

    const tracks = [...playlist.tracks];
    if (shuffle) {
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
      }
    }

    const local: string[] = [];
    const pending: { track: (typeof tracks)[0] }[] = [];
    const results: { title: string; status: string; error?: string }[] = [];
    let firstPlayed = false;

    for (const track of tracks) {
      // Check if track has a file path set and it exists on disk
      const filepath = track.file ? join(deps.musicDir, track.file) : "";
      if (filepath && existsSync(filepath)) {
        local.push(`/music/${track.file}`);
        results.push({ title: track.title, status: "queued" });
        continue;
      }
      // Check if track's spotifyUrl already exists in the library
      if (track.spotifyUrl) {
        const libTrack = deps.libraryRepo.getTrackByUrl(track.spotifyUrl);
        if (libTrack) {
          local.push(`/music/${libTrack.file}`);
          results.push({ title: libTrack.title, status: "queued" });
          continue;
        }
        pending.push({ track });
      } else if (track.file) {
        results.push({ title: track.title, status: "error", error: "File not found" });
      }
    }

    // Play local files immediately
    if (local.length > 0) {
      const ok = await deps.liquidsoapService.playFilesNow(local);
      firstPlayed = ok;
    }

    // Fire all pending Spotify downloads — when first completes, flush queue and play it
    let firstDownloadFired = false;
    for (const p of pending) {
      deps.downloadService
        .downloadFromSpotify(p.track.spotifyUrl!, async (downloaded) => {
          const filepath = `/music/${downloaded.file}`;
          if (!firstPlayed && !firstDownloadFired) {
            firstDownloadFired = true;
            await deps.liquidsoapService.sendCommand("queue.flush_and_skip").catch(() => {});
            await new Promise((r) => setTimeout(r, 500));
            const rid = await deps.liquidsoapService.queuePush(filepath);
            console.log(`[play] First downloaded track played: ${downloaded.title} rid=${rid}`);
            firstPlayed = true;
          } else {
            const rid = await deps.liquidsoapService.queuePush(filepath);
            console.log(`[play] Queued (async): ${downloaded.title} rid=${rid}`);
          }
          results.push({ title: downloaded.title, status: "queued" });
        })
        .catch((err: any) => {
          results.push({ title: p.track.title, status: "error", error: err.message });
          return null;
        });
    }

    const totalQueued = local.length + pending.length;
    if (totalQueued === 0) {
      return c.json({ ok: false, error: "No playable tracks found" }, 400);
    }

    return c.json({
      ok: true,
      data: {
        playlistId: playlist.id,
        action: "play",
        shuffle,
        localQueued: local.length,
        pendingDownloads: pending.length,
        firstPlayed,
        results,
      },
    });
  });

  app.post("/api/playlists/:id/queue", async (c) => {
    const playlist = deps.playlistRepo.get(c.req.param("id"));
    if (!playlist) return c.json({ ok: false, error: "Playlist not found" }, 404);
    if (playlist.tracks.length === 0) {
      return c.json({ ok: false, error: "Playlist is empty" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const shuffle = body?.shuffle === true;

    const tracks = [...playlist.tracks];
    if (shuffle) {
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
      }
    }

    const results: { title: string; status: string; error?: string }[] = [];
    const pending: { track: (typeof tracks)[0]; filepath: string }[] = [];

    for (const track of tracks) {
      const filepath = track.file ? join(deps.musicDir, track.file) : "";
      if (filepath && existsSync(filepath)) {
        const rid = await deps.liquidsoapService.queuePush(`/music/${track.file}`);
        results.push({ title: track.title, status: rid ? "queued" : "error" });
        continue;
      }
      if (track.spotifyUrl) {
        pending.push({ track, filepath });
      } else if (track.file) {
        results.push({ title: track.title, status: "error", error: "File not found" });
      }
    }

    for (const p of pending) {
      deps.downloadService
        .downloadFromSpotify(p.track.spotifyUrl!, async (downloaded) => {
          const rid = await deps.liquidsoapService.queuePush(`/music/${downloaded.file}`);
          results.push({ title: downloaded.title, status: rid ? "queued" : "error" });
        })
        .catch((err: any) => {
          results.push({ title: p.track.title, status: "error", error: err.message });
          return null;
        });
    }

    const queue = await deps.liquidsoapService.queueList();
    return c.json({
      ok: true,
      data: {
        playlistId: playlist.id,
        action: "queue",
        shuffle,
        queued: results.filter((r) => r.status === "queued").length,
        results,
        queue,
      },
    });
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
