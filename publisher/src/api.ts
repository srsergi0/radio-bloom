import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig, updateConfig } from "./config";
import {
  addPlaylistTrack,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  removePlaylistTrack,
  reorderPlaylistTracks,
  searchLibrary,
  updatePlaylistName,
} from "./db";
import {
  deleteTrack,
  getLibraryStats,
  getTrackByFile,
  getTrackByUrl,
  listInterludios,
  listSongs,
  scanLibrary,
} from "./library";
import {
  getStreamStatus,
  isLiquidsoapConnected,
  pausePlayback,
  playFileNow,
  queueClear,
  queueInsert,
  queueList,
  queuePush,
  queueRemove,
  reloadPlaylist,
  sendCommand,
  skipTrack,
  startPlayback,
} from "./liquidsoap";
import { handleMcpHttpRequest } from "./mcp";
import { downloadFromSpotify } from "./spotdl";

const MUSIC_DIR = process.env.MUSIC_DIR || "/app/music";

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
  const liquidsoapConnected = isLiquidsoapConnected();
  const config = loadConfig();
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
  return c.json({ ok: true, data: loadConfig() });
});

app.put("/api/system/config", async (c) => {
  const body = await c.req.json();
  const config = updateConfig(body);
  return c.json({ ok: true, data: config });
});

// ============================================================
// LIBRARY
// ============================================================

app.get("/api/library", (c) => {
  const songs = listSongs();
  const interludios = listInterludios();
  return c.json({ ok: true, data: { songs, interludios } });
});

app.get("/api/library/songs", (c) => {
  return c.json({ ok: true, data: listSongs() });
});

app.get("/api/library/interludios", (c) => {
  return c.json({ ok: true, data: listInterludios() });
});

app.get("/api/library/stats", (c) => {
  return c.json({ ok: true, data: getLibraryStats() });
});

app.get("/api/library/track", (c) => {
  const file = c.req.query("file");
  if (!file) return c.json({ ok: false, error: "file query param required" }, 400);
  const track = getTrackByFile(file);
  if (!track) return c.json({ ok: false, error: "Track not found" }, 404);
  return c.json({ ok: true, data: track });
});

app.delete("/api/library/track", (c) => {
  const file = c.req.query("file");
  if (!file) return c.json({ ok: false, error: "file query param required" }, 400);
  const deleted = deleteTrack(file);
  if (!deleted) return c.json({ ok: false, error: "File not found or could not delete" }, 404);
  return c.json({ ok: true, data: { deleted: file } });
});

app.post("/api/library/scan", (c) => {
  const stats = scanLibrary();
  return c.json({ ok: true, data: stats });
});

app.get("/api/library/search", (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ ok: false, error: "q query param required" }, 400);
  const results = searchLibrary(q);
  return c.json({ ok: true, data: results });
});

app.post("/api/library/:id/play", async (c) => {
  const id = c.req.param("id");
  const allTracks = [...listSongs(), ...listInterludios()];
  console.log("[library/play] id:", id, "total tracks:", allTracks.length);
  const track = allTracks.find((t) => t.id === id);
  if (!track) return c.json({ ok: false, error: "Track not found" }, 404);
  const filepath = `/music/${track.file}`;
  const ok = await playFileNow(filepath);
  if (!ok) return c.json({ ok: false, error: "Failed to play track" }, 500);
  return c.json({ ok: true, data: { action: "play", track } });
});

// ============================================================
// STREAM CONTROL (Liquidsoap)
// ============================================================

app.get("/api/stream", async (c) => {
  const status = await getStreamStatus();
  return c.json({ ok: true, data: status });
});

app.post("/api/stream/play", async (c) => {
  try {
    await startPlayback();
    return c.json({ ok: true, data: { action: "play" } });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

app.post("/api/stream/pause", async (c) => {
  try {
    await pausePlayback();
    return c.json({ ok: true, data: { action: "pause" } });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

async function handleSkip(c: any) {
  try {
    await skipTrack();
    await new Promise((r) => setTimeout(r, 500));
    const status = await getStreamStatus();
    return c.json({ ok: true, data: { action: "skip", nowPlaying: status } });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
}

app.get("/api/stream/skip", handleSkip);
app.post("/api/stream/skip", handleSkip);

app.post("/api/stream/reload", async (c) => {
  try {
    await reloadPlaylist();
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

    const existing = getTrackByUrl(url);
    if (!existing) {
      const { downloadFromSpotify } = await import("./spotdl");
      const job = await downloadFromSpotify(url, async (track) => {
        const filepath = `/music/${track.file}`;
        await queuePush(filepath);
      });
      const list = await queueList();
      return c.json({ ok: true, data: { source: "download", job, queue: list } });
    }

    const filepath = `/music/${existing.file}`;
    const rid = await queuePush(filepath);
    const list = await queueList();
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
    const items = await queueList();
    return c.json({ ok: true, data: items });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

app.delete("/api/stream/queue", async (c) => {
  try {
    await queueClear();
    return c.json({ ok: true, data: { cleared: true } });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500);
  }
});

app.delete("/api/stream/queue/:rid", async (c) => {
  try {
    const rid = c.req.param("rid");
    const ok = await queueRemove(rid);
    if (!ok)
      return c.json(
        { ok: false, error: "RID not found in queue (ya pasó a reproducción o no existe)" },
        404
      );
    const list = await queueList();
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

    const existing = getTrackByUrl(url);
    if (existing) {
      const ok = await queueInsert(index, `/music/${existing.file}`);
      if (!ok) return c.json({ ok: false, error: "Failed to insert" }, 500);
      const list = await queueList();
      return c.json({ ok: true, data: { index, track: existing, queue: list } });
    }

    const { downloadFromSpotify } = await import("./spotdl");
    const job = await downloadFromSpotify(url, async (track) => {
      await queueInsert(index, `/music/${track.file}`).catch(() => {});
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

    const existing = getTrackByUrl(url);
    if (existing) {
      const filepath = `/music/${existing.file}`;
      await sendCommand("queue.flush_and_skip");
      await new Promise((r) => setTimeout(r, 500));
      const rid = await queuePush(filepath);
      if (!rid) return c.json({ ok: false, error: "Failed to queue" }, 500);
      const st = await getStreamStatus();
      const list = await queueList();
      return c.json({
        ok: true,
        data: { source: "library", track: existing, nowPlaying: st, queue: list },
      });
    }

    const { downloadFromSpotify } = await import("./spotdl");
    const job = await downloadFromSpotify(url, async (track) => {
      const filepath = `/music/${track.file}`;
      await sendCommand("queue.flush_and_skip").catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      await queuePush(filepath).catch(() => {});
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
  const playlist = createPlaylist(body.name);
  return c.json({ ok: true, data: playlist });
});

app.get("/api/playlists", (c) => {
  return c.json({ ok: true, data: listPlaylists() });
});

app.get("/api/playlists/:id", (c) => {
  const playlist = getPlaylist(c.req.param("id"));
  if (!playlist) return c.json({ ok: false, error: "Playlist not found" }, 404);
  return c.json({ ok: true, data: playlist });
});

app.put("/api/playlists/:id", async (c) => {
  const body = await c.req.json();
  if (!body.name) return c.json({ ok: false, error: "name is required" }, 400);
  const ok = updatePlaylistName(c.req.param("id"), body.name);
  if (!ok) return c.json({ ok: false, error: "Playlist not found" }, 404);
  return c.json({ ok: true, data: getPlaylist(c.req.param("id")) });
});

app.delete("/api/playlists/:id", (c) => {
  const ok = deletePlaylist(c.req.param("id"));
  if (!ok) return c.json({ ok: false, error: "Playlist not found" }, 404);
  return c.json({ ok: true, data: { deleted: c.req.param("id") } });
});

app.post("/api/playlists/:id/tracks", async (c) => {
  const body = await c.req.json();
  if (!body.title) return c.json({ ok: false, error: "title is required" }, 400);
  const track = addPlaylistTrack(c.req.param("id"), {
    type: body.type || "song",
    file: body.file,
    title: body.title,
    artist: body.artist,
    duration: body.duration || 0,
    spotifyUrl: body.spotifyUrl,
  });
  if (!track) return c.json({ ok: false, error: "Playlist not found" }, 404);
  return c.json({ ok: true, data: track });
});

app.delete("/api/playlists/:id/tracks/:trackId", (c) => {
  const ok = removePlaylistTrack(c.req.param("id"), c.req.param("trackId"));
  if (!ok) return c.json({ ok: false, error: "Track not found" }, 404);
  return c.json({ ok: true, data: { removed: c.req.param("trackId") } });
});

app.put("/api/playlists/:id/tracks/reorder", async (c) => {
  const body = await c.req.json();
  if (!body.trackIds || !Array.isArray(body.trackIds)) {
    return c.json({ ok: false, error: "trackIds array is required" }, 400);
  }
  reorderPlaylistTracks(c.req.param("id"), body.trackIds);
  return c.json({ ok: true, data: getPlaylist(c.req.param("id")) });
});

app.post("/api/playlists/:id/load", async (c) => {
  const playlist = getPlaylist(c.req.param("id"));
  if (!playlist) return c.json({ ok: false, error: "Playlist not found" }, 404);

  const results: { title: string; status: string; error?: string }[] = [];
  const pending: { track: (typeof playlist.tracks)[0]; filepath: string }[] = [];

  for (const track of playlist.tracks) {
    const filepath = track.file ? join(MUSIC_DIR, track.file) : "";
    if (filepath && existsSync(filepath)) {
      const rid = await queuePush(`/music/${track.file}`);
      results.push({ title: track.title, status: rid ? "queued" : "error" });
      continue;
    }
    if (track.spotifyUrl) {
      pending.push({ track, filepath });
    } else if (track.file) {
      results.push({ title: track.title, status: "error", error: "File not found" });
    }
  }

  // Download pending tracks in batches (2 at a time), queue as they complete
  const BATCH = 2;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const downloads = batch.map((p) =>
      downloadFromSpotify(p.track.spotifyUrl!, async (downloaded) => {
        const rid = await queuePush(`/music/${downloaded.file}`);
        results.push({ title: downloaded.title, status: rid ? "queued" : "error" });
      }).catch((err: any) => {
        results.push({ title: p.track.title, status: "error", error: err.message });
        return null;
      })
    );
    await Promise.allSettled(downloads);
  }

  return c.json({ ok: true, data: { playlistId: playlist.id, results } });
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
    const response = await handleMcpHttpRequest(c.req.raw);
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

import { serveStatic } from "hono/bun";
import { resolve } from "node:path";

const DIST_DIR = process.env.NODE_ENV === "production"
  ? "/app/web/dist"
  : resolve(import.meta.dirname || "", "../../web/dist");

app.use("/*", serveStatic({
  root: DIST_DIR,
  rewriteRequestPath: (path) => {
    if (path === "/en" || path === "/en/") return "/en/index.html";
    return path;
  }
}));

export default app;
