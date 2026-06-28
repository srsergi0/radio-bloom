import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMP_DIR = join(__dirname, "temp_integration");

process.env.DATA_DIR = process.env.DATA_DIR || join(TEMP_DIR, "data");
process.env.MUSIC_DIR = process.env.MUSIC_DIR || join(TEMP_DIR, "music");
process.env.MUSIC_MOUNT = process.env.MUSIC_MOUNT || join(TEMP_DIR, "music");

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import type { Track, SystemConfig, LibraryStats } from "../src/domain/types";

const mockSongs: Track[] = [
  { id: "s1", type: "song", file: "songs/cancion1.mp3", title: "Canción 1", artist: "Artist A", duration: 200, addedAt: "2024-01-01" },
  { id: "s2", type: "song", file: "songs/cancion2.mp3", title: "Canción 2", artist: "Artist B", duration: 180, addedAt: "2024-01-02" },
];

const mockInterludios: Track[] = [
  { id: "i1", type: "interludio", file: "interludios/pausa1.mp3", title: "Pausa 1", duration: 30, addedAt: "2024-01-01" },
];

const mockStats: LibraryStats = { totalSongs: 2, totalInterludios: 1, totalSizeBytes: 5000000, totalDurationSeconds: 410 };

const mockConfig: SystemConfig = { streamBitrate: 320, streamSampleRate: 44100, crossfadeDuration: 3, playlistReloadSeconds: 30 };

const mockStreamStatus = {
  connected: true, playing: true, currentTrack: "123",
  artist: "Artist A", title: "Canción 1", uptime: "3600",
  duration: 200, elapsed: 42, metadata: { artist: "Artist A", title: "Canción 1" },
};

const realLibrary = require("../src/library.ts?real");
const mockLibraryRaw = {
  listSongs: mock(() => [...mockSongs]),
  listInterludios: mock(() => [...mockInterludios]),
  deleteTrack: mock((file: string) => file === "songs/exists.mp3"),
  getLibraryStats: mock(() => ({ ...mockStats })),
  scanLibrary: mock(() => ({ ...mockStats })),
  getTrackByFile: mock((file: string) => {
    const all = [...mockSongs, ...mockInterludios];
    return all.find((t) => t.file === file) || null;
  }),
  getTrackByUrl: mock((url: string) => {
    const all = [...mockSongs, ...mockInterludios];
    return all.find((t) => t.spotifyUrl === url) || null;
  }),
};

const mockLibrary = {};
const allLibraryKeys = new Set([...Object.keys(mockLibraryRaw), ...Object.keys(realLibrary)]);
for (const key of allLibraryKeys) {
  mockLibrary[key] = mock((...args) => {
    if (process.env.IS_INTEGRATION_TEST === "true") {
      return realLibrary[key] ? realLibrary[key](...args) : undefined;
    }
    return mockLibraryRaw[key] ? mockLibraryRaw[key](...args) : undefined;
  });
}

mock.module("../src/library", () => mockLibrary);

let queueStore: { rid: string; filepath: string }[] = [];
let ridCounter = 0;

const mockLiquidsoap = {
  skipTrack: mock(() => Promise.resolve()),
  pausePlayback: mock(() => Promise.resolve()),
  startPlayback: mock(() => Promise.resolve()),
  getStreamStatus: mock(() => Promise.resolve({ ...mockStreamStatus })),
  reloadPlaylist: mock(() => Promise.resolve()),
  isLiquidsoapConnected: mock(() => true),
  queuePush: mock((filepath: string) => {
    ridCounter++;
    const rid = String(ridCounter);
    queueStore.push({ rid, filepath });
    return Promise.resolve(rid);
  }),
  queueList: mock(() => Promise.resolve(queueStore.map((q) => ({ rid: q.rid, artist: "", title: q.filepath.split("/").pop() || q.filepath })))),
  queueClear: mock(() => { queueStore = []; return Promise.resolve(); }),
  queueRemove: mock((rid: string) => {
    const idx = queueStore.findIndex((q) => q.rid === rid);
    if (idx === -1) return Promise.resolve(false);
    queueStore.splice(idx, 1);
    return Promise.resolve(true);
  }),
  queueInsert: mock((index: number, filepath: string) => {
    const safeIdx = Math.max(0, Math.min(index, queueStore.length));
    ridCounter++;
    queueStore.splice(safeIdx, 0, { rid: String(ridCounter), filepath });
    return Promise.resolve(true);
  }),
  playFileNow: mock((filepath: string) => Promise.resolve(true)),
  queueLength: mock(() => Promise.resolve(queueStore.length)),
  sendCommand: mock((cmd: string) => Promise.resolve(["OK"])),
  clearAndPush: mock((filepath: string) => {
    queueStore = [];
    ridCounter++;
    const rid = String(ridCounter);
    queueStore.push({ rid, filepath });
    return Promise.resolve(rid);
  }),
  getRequestMetadata: mock((rid: string) => Promise.resolve({})),
  initLiquidsoap: mock(() => {}),
};

mock.module("../src/liquidsoap", () => mockLiquidsoap);

let configStore = { ...mockConfig };

const realDb = require("../src/db.ts?real");
const mockDbRaw = {
  searchLibrary: mock((q: string) => {
    const all = [...mockSongs, ...mockInterludios];
    const items = all.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()) || (t.artist?.toLowerCase() || "").includes(q.toLowerCase()));
    return { items, total: items.length };
  }),
  createPlaylist: mock((name: string) => ({ id: "pl_1", name, tracks: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
  listPlaylists: mock(() => []),
  getPlaylist: mock((id: string) => id === "pl_exists" ? { id: "pl_exists", name: "Test", tracks: [], createdAt: "", updatedAt: "" } : null),
  updatePlaylistName: mock((id: string) => id === "pl_exists"),
  deletePlaylist: mock((id: string) => id === "pl_exists"),
  addPlaylistTrack: mock((playlistId: string) => playlistId === "pl_exists" ? { id: "pt_1", playlistId, pos: 0, type: "song", title: "Test", duration: 100, addedAt: "" } : null),
  removePlaylistTrack: mock((playlistId: string, trackId: string) => playlistId === "pl_exists" && trackId === "pt_exists"),
  reorderPlaylistTracks: mock(() => true),
  getLibraryTrack: mock((file: string) => {
    const all = [...mockSongs, ...mockInterludios];
    return all.find((t) => t.file === file) || null;
  }),
  upsertLibraryTrack: mock(() => {}),
  removeLibraryTrack: mock(() => {}),
  getAllLibraryTracks: mock((type?: string) => type ? (type === "song" ? mockSongs : mockInterludios) : [...mockSongs, ...mockInterludios]),
  getLibraryTracksPage: mock((type: string) => type === "song" ? mockSongs : mockInterludios),
  countLibraryTracks: mock((type: string) => type === "song" ? mockSongs.length : mockInterludios.length),
  getLibraryStats: mock(() => ({ ...mockStats })),
  getLibraryTrackByUrl: mock((url: string) => {
    return mockSongs.find((t) => t.spotifyUrl === url) || null;
  }),
  createDownload: mock((url: string) => ({ id: "dl_1", url, status: "queued", startedAt: new Date().toISOString() })),
  updateDownload: mock(() => {}),
  getDownload: mock((id: string) => null),
  getAllDownloads: mock(() => []),
  clearDownloads: mock(() => {}),
  loadConfig: mock(() => ({ ...configStore })),
  saveConfig: mock((config: SystemConfig) => { configStore = { ...config }; }),
  updateConfig: mock((updates: Partial<SystemConfig>) => {
    configStore = { ...configStore, ...updates };
    return { ...configStore };
  }),
  getDB: mock(() => ({})),
  initDB: mock(() => ({}) as any),
};

const mockDb = {};
const allDbKeys = new Set([...Object.keys(mockDbRaw), ...Object.keys(realDb)]);
for (const key of allDbKeys) {
  mockDb[key] = mock((...args) => {
    if (process.env.IS_INTEGRATION_TEST === "true") {
      return realDb[key] ? realDb[key](...args) : undefined;
    }
    return mockDbRaw[key] ? mockDbRaw[key](...args) : undefined;
  });
}

mock.module("../src/db", () => mockDb);

mock.module("../src/config", () => ({
  loadConfig: mock(() => ({ ...configStore })),
  saveConfig: mock((config: SystemConfig) => { configStore = { ...config }; }),
  updateConfig: mock((updates: Partial<SystemConfig>) => {
    configStore = { ...configStore, ...updates };
    return { ...configStore };
  }),
}));

mock.module("../src/mcp", () => ({
  handleMcpHttpRequest: mock(() => new Response("MCP transport not initialized", { status: 503 })),
  getHttpTransport: mock(() => null),
  createHttpTransport: mock(() => {}),
  server: { connect: mock(() => {}) },
}));

mock.module("../src/spotdl", () => ({
  downloadFromSpotify: mock((url: string, onComplete?: (track: Track) => void) => {
    const track: Track = { id: "dl_track", type: "song", file: "songs/downloaded.mp3", title: "Downloaded", duration: 180, spotifyUrl: url, addedAt: new Date().toISOString() };
    if (onComplete) onComplete(track);
    return Promise.resolve({ id: "dl_1", url, status: "done", result: track, startedAt: "", completedAt: new Date().toISOString() });
  }),
}));

const app = (await import("../src/api")).default;

beforeEach(() => {
  queueStore = [];
  ridCounter = 0;
  configStore = { ...mockConfig };
});

function req(method: string, path: string, body?: any) {
  const url = new URL(path, "http://localhost");
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return app.fetch(new Request(url, init));
}

// ============================================================
// HEALTH
// ============================================================
describe("GET /api/health", () => {
  test("returns ok", async () => {
    const res = await req("GET", "/api/health");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe("running");
    expect(json.data.timestamp).toBeDefined();
  });
});

// ============================================================
// SYSTEM
// ============================================================
describe("System endpoints", () => {
  test("GET /api/system/status", async () => {
    const res = await req("GET", "/api/system/status");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.liquidsoap.connected).toBe(true);
    expect(json.data.config.streamBitrate).toBe(320);
  });

  test("GET /api/system/config", async () => {
    const res = await req("GET", "/api/system/config");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.streamBitrate).toBe(320);
  });

  test("PUT /api/system/config", async () => {
    const res = await req("PUT", "/api/system/config", { streamBitrate: 192 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.streamBitrate).toBe(192);
  });
});

// ============================================================
// LIBRARY
// ============================================================
describe("Library endpoints", () => {
  test("GET /api/library", async () => {
    const res = await req("GET", "/api/library");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.songs).toHaveLength(2);
    expect(json.data.interludios).toHaveLength(1);
  });

  test("GET /api/library/songs", async () => {
    const res = await req("GET", "/api/library/songs");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
  });

  test("GET /api/library/interludios", async () => {
    const res = await req("GET", "/api/library/interludios");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
  });

  test("GET /api/library/stats", async () => {
    const res = await req("GET", "/api/library/stats");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalSongs).toBe(2);
  });

  test("GET /api/library/track?file=... - found", async () => {
    const res = await req("GET", "/api/library/track?file=songs/cancion1.mp3");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.title).toBe("Canción 1");
  });

  test("GET /api/library/track - missing file param", async () => {
    const res = await req("GET", "/api/library/track");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("GET /api/library/track?file=... - not found", async () => {
    const res = await req("GET", "/api/library/track?file=nonexistent.mp3");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/library/track?file=... - missing file param", async () => {
    const res = await req("DELETE", "/api/library/track");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/library/track?file=... - not found", async () => {
    const res = await req("DELETE", "/api/library/track?file=nonexistent.mp3");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/library/track?file=... - found", async () => {
    const res = await req("DELETE", "/api/library/track?file=songs/exists.mp3");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test("POST /api/library/scan", async () => {
    const res = await req("POST", "/api/library/scan");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalSongs).toBe(2);
  });

  test("GET /api/library/search?q=... - found", async () => {
    const res = await req("GET", "/api/library/search?q=Canción");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.items.length).toBeGreaterThan(0);
  });

  test("GET /api/library/search - missing q param", async () => {
    const res = await req("GET", "/api/library/search");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/library/:id/play - found", async () => {
    const res = await req("POST", "/api/library/s1/play");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.action).toBe("play");
  });

  test("POST /api/library/:id/play - not found", async () => {
    const res = await req("POST", "/api/library/nonexistent/play");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});

// ============================================================
// STREAM CONTROL
// ============================================================
describe("Stream control endpoints", () => {
  test("GET /api/stream", async () => {
    const res = await req("GET", "/api/stream");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.playing).toBe(true);
  });

  test("POST /api/stream/play", async () => {
    const res = await req("POST", "/api/stream/play");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.action).toBe("play");
  });

  test("POST /api/stream/pause", async () => {
    const res = await req("POST", "/api/stream/pause");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.action).toBe("pause");
  });

  test("GET /api/stream/skip", async () => {
    const res = await req("GET", "/api/stream/skip");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.action).toBe("skip");
  });

  test("POST /api/stream/skip", async () => {
    const res = await req("POST", "/api/stream/skip");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.action).toBe("skip");
  });

  test("POST /api/stream/reload", async () => {
    const res = await req("POST", "/api/stream/reload");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.action).toBe("reload");
  });
});

// ============================================================
// QUEUE
// ============================================================
describe("Queue endpoints", () => {
  test("GET /api/stream/queue - empty", async () => {
    const res = await req("GET", "/api/stream/queue");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  test("POST /api/stream/queue - missing url", async () => {
    const res = await req("POST", "/api/stream/queue", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/stream/queue - from library", async () => {
    const res = await req("POST", "/api/stream/queue", { url: "https://open.spotify.com/track/mock1" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.source).toBe("download");
  });

  test("POST /api/stream/queue - download when not in library", async () => {
    const res = await req("POST", "/api/stream/queue", { url: "https://open.spotify.com/track/new" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.source).toBe("download");
  });

  test("DELETE /api/stream/queue - clear queue", async () => {
    const res = await req("DELETE", "/api/stream/queue");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.cleared).toBe(true);
  });

  test("DELETE /api/stream/queue/:rid - not found", async () => {
    const res = await req("DELETE", "/api/stream/queue/999");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/stream/queue/:rid - found", async () => {
    await req("POST", "/api/stream/queue", { url: "https://open.spotify.com/track/q1" });
    const res = await req("DELETE", "/api/stream/queue/1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.removed).toBe("1");
  });

  test("POST /api/stream/queue/insert - missing params", async () => {
    const res = await req("POST", "/api/stream/queue/insert", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/stream/queue/insert - success", async () => {
    const res = await req("POST", "/api/stream/queue/insert", { index: 0, url: "https://open.spotify.com/track/mock1" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test("POST /api/stream/play/url - missing url", async () => {
    const res = await req("POST", "/api/stream/play/url", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/stream/play/url - success", async () => {
    const res = await req("POST", "/api/stream/play/url", { url: "https://open.spotify.com/track/mock1" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});

// ============================================================
// PLAYLISTS
// ============================================================
describe("Playlist endpoints", () => {
  test("POST /api/playlists - missing name", async () => {
    const res = await req("POST", "/api/playlists", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/playlists - success", async () => {
    const res = await req("POST", "/api/playlists", { name: "Test Playlist" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.name).toBe("Test Playlist");
  });

  test("GET /api/playlists - empty", async () => {
    const res = await req("GET", "/api/playlists");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  test("GET /api/playlists/:id - not found", async () => {
    const res = await req("GET", "/api/playlists/nonexistent");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("GET /api/playlists/:id - found", async () => {
    const res = await req("GET", "/api/playlists/pl_exists");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.name).toBe("Test");
  });

  test("PUT /api/playlists/:id - missing name", async () => {
    const res = await req("PUT", "/api/playlists/pl_exists", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("PUT /api/playlists/:id - not found", async () => {
    const res = await req("PUT", "/api/playlists/nonexistent", { name: "New" });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("PUT /api/playlists/:id - success", async () => {
    const res = await req("PUT", "/api/playlists/pl_exists", { name: "Updated" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test("DELETE /api/playlists/:id - not found", async () => {
    const res = await req("DELETE", "/api/playlists/nonexistent");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/playlists/:id - success", async () => {
    const res = await req("DELETE", "/api/playlists/pl_exists");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test("POST /api/playlists/:id/tracks - missing title", async () => {
    const res = await req("POST", "/api/playlists/pl_exists/tracks", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/playlists/:id/tracks - playlist not found", async () => {
    const res = await req("POST", "/api/playlists/nonexistent/tracks", { title: "Test" });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/playlists/:id/tracks - success", async () => {
    const res = await req("POST", "/api/playlists/pl_exists/tracks", { title: "New Track" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test("DELETE /api/playlists/:id/tracks/:trackId - not found", async () => {
    const res = await req("DELETE", "/api/playlists/pl_exists/tracks/nonexistent");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/playlists/:id/tracks/:trackId - success", async () => {
    const res = await req("DELETE", "/api/playlists/pl_exists/tracks/pt_exists");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test("PUT /api/playlists/:id/tracks/reorder - missing trackIds", async () => {
    const res = await req("PUT", "/api/playlists/pl_exists/tracks/reorder", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("PUT /api/playlists/:id/tracks/reorder - success", async () => {
    const res = await req("PUT", "/api/playlists/pl_exists/tracks/reorder", { trackIds: ["pt1", "pt2"] });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test("POST /api/playlists/:id/load - playlist not found", async () => {
    const res = await req("POST", "/api/playlists/nonexistent/load");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/playlists/:id/load - empty playlist", async () => {
    const res = await req("POST", "/api/playlists/pl_exists/load");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});

// ============================================================
// MCP
// ============================================================
describe("MCP endpoint", () => {
  test("ALL /mcp - no transport", async () => {
    const res = await req("POST", "/mcp");
    expect(res.status).toBe(503);
  });
});
