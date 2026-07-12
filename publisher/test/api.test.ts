import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMP_DIR = join(__dirname, "temp_integration");

process.env.DATA_DIR = process.env.DATA_DIR || join(TEMP_DIR, "data");
process.env.MUSIC_DIR = process.env.MUSIC_DIR || join(TEMP_DIR, "music");
process.env.MUSIC_MOUNT = process.env.MUSIC_MOUNT || join(TEMP_DIR, "music");

import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { Track, SystemConfig, LibraryStats } from "../src/domain/types";
import { createApiRouter } from "../src/api/router";

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

let queueStore: { rid: string; artist: string; title: string; type?: "song" | "interludio" }[] = [];
let ridCounter = 0;
let configStore = { ...mockConfig };
let bullMqJobs: { id: string; type: "file" | "tts"; data: any }[] = [];
let bullMqJobIdCounter = 0;

const mockConfigService = {
  get: mock(() => ({ ...configStore })),
  update: mock((updates: Partial<SystemConfig>) => {
    configStore = { ...configStore, ...updates };
    return { ...configStore };
  }),
};

const mockLibraryRepo = {
  getTrackById: mock((id: string) => {
    const all = [...mockSongs, ...mockInterludios];
    return all.find((t) => t.id === id) || null;
  }),
  search: mock((q: string) => {
    const all = [...mockSongs, ...mockInterludios];
    const items = all.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()) || (t.artist?.toLowerCase() || "").includes(q.toLowerCase()));
    return { items, total: items.length };
  }),
};

const mockLibraryService = {
  listSongs: mock(() => [...mockSongs]),
  listInterludios: mock(() => [...mockInterludios]),
  getTrackById: mock((id: string) => {
    const all = [...mockSongs, ...mockInterludios];
    return all.find((t) => t.id === id) || null;
  }),
  deleteTrack: mock((file: string) => file === "songs/cancion1.mp3"),
  rescan: mock(() => Promise.resolve({ ...mockStats })),
};

const mockLiquidsoapService = {
  isConnected: mock(() => true),
  startPlayback: mock(() => Promise.resolve()),
  pausePlayback: mock(() => Promise.resolve()),
  skipTrack: mock(() => Promise.resolve()),
  reloadPlaylist: mock(() => Promise.resolve()),
  getCurrentTrack: mock(() => Promise.resolve({ ...mockStreamStatus })),
  queuePush: mock((filepath: string) => {
    ridCounter++;
    const rid = String(ridCounter);
    queueStore.push({ rid, artist: "", title: filepath.split("/").pop() || filepath, type: filepath.includes("interludio") ? "interludio" : "song" });
    return Promise.resolve(rid);
  }),
  queueList: mock(() => Promise.resolve({ items: [...queueStore], total: queueStore.length })),
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
    queueStore.splice(safeIdx, 0, {
      rid: String(ridCounter),
      artist: "",
      title: filepath.split("/").pop() || filepath,
      type: filepath.includes("interludio") ? "interludio" : "song"
    });
    return Promise.resolve(true);
  }),
  playFileNow: mock((filepath: string) => Promise.resolve(true)),
  getStreamStatus: mock(() => Promise.resolve({ ...mockStreamStatus })),
};

const mockLiquidsoapQueueService = {
  add: mock((filepath: string) => {
    bullMqJobIdCounter++;
    const id = `bmq-file-${bullMqJobIdCounter}`;
    bullMqJobs.push({ id, type: "file", data: { filepath } });
    return Promise.resolve({ id, data: { filepath } });
  }),
  addTts: mock((script: string, voice?: string) => {
    bullMqJobIdCounter++;
    const id = `bmq-tts-${bullMqJobIdCounter}`;
    bullMqJobs.push({ id, type: "tts", data: { script, voice } });
    return Promise.resolve({ id, data: { script, voice } });
  }),
  getQueue: mock(() => ({
    name: "liquidsoap-queue",
    client: {},
    close: () => Promise.resolve(),
    on: () => {},
    metaValues: { version: "bullmq-mock" },
  })),
};

const playlistStore: Record<string, { id: string; name: string; played: boolean; tracks: any[]; createdAt: string; updatedAt: string }> = {
  pl_songs: {
    id: "pl_songs", name: "Songs Only", played: false, tracks: [
      { id: "pt1", playlistId: "pl_songs", pos: 0, type: "song", file: "songs/cancion1.mp3", title: "Canción 1", artist: "Artist A", duration: 200, addedAt: "2024-01-01" },
      { id: "pt2", playlistId: "pl_songs", pos: 1, type: "song", file: "songs/cancion2.mp3", title: "Canción 2", artist: "Artist B", duration: 180, addedAt: "2024-01-02" },
    ], createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
  },
  pl_scripts: {
    id: "pl_scripts", name: "Scripts Only", played: false, tracks: [
      { id: "pt3", playlistId: "pl_scripts", pos: 0, type: "interludio", file: null, title: "Saludo", script: "Bienvenidos a la radio", duration: 0, addedAt: "2024-01-01" },
      { id: "pt4", playlistId: "pl_scripts", pos: 1, type: "interludio", file: null, title: "Despedida", script: "Gracias por escuchar", duration: 0, addedAt: "2024-01-01" },
    ], createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
  },
  pl_mixed: {
    id: "pl_mixed", name: "Mixed", played: false, tracks: [
      { id: "pt5", playlistId: "pl_mixed", pos: 0, type: "song", file: "songs/cancion1.mp3", title: "Canción 1", artist: "Artist A", duration: 200, addedAt: "2024-01-01" },
      { id: "pt6", playlistId: "pl_mixed", pos: 1, type: "interludio", file: null, title: "Saludo", script: "Bienvenidos", duration: 0, addedAt: "2024-01-01" },
      { id: "pt7", playlistId: "pl_mixed", pos: 2, type: "song", file: "songs/cancion2.mp3", title: "Canción 2", artist: "Artist B", duration: 180, addedAt: "2024-01-02" },
      { id: "pt8", playlistId: "pl_mixed", pos: 3, type: "interludio", file: "interludios/pausa1.mp3", title: "Pausa 1", duration: 30, addedAt: "2024-01-01" },
    ], createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
  },
  pl_empty: {
    id: "pl_empty", name: "Empty", played: false, tracks: [], createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
  },
};

const mockPlaylistRepo = {
  create: mock((name: string) => ({ id: "pl_new", name, played: false, tracks: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })),
  list: mock(() => Object.values(playlistStore).map(({ id, name, played, createdAt, updatedAt }) => ({ id, name, played, createdAt, updatedAt }))),
  get: mock((id: string) => {
    const p = playlistStore[id];
    if (!p) return null;
    return { ...p };
  }),
  update: mock((id: string, updates: { name?: string; played?: boolean }) => {
    if (!playlistStore[id]) return false;
    if (updates.name !== undefined) playlistStore[id].name = updates.name;
    if (updates.played !== undefined) playlistStore[id].played = updates.played;
    return true;
  }),
  delete: mock((id: string) => {
    if (!playlistStore[id]) return false;
    delete playlistStore[id];
    return true;
  }),
  addTrack: mock((playlistId: string, trackData: any, position?: number) => {
    if (!playlistStore[playlistId]) return null;
    return { id: "pt_new", playlistId, pos: position || 0, type: trackData.type || "song", title: trackData.title, duration: trackData.duration || 0, addedAt: new Date().toISOString() };
  }),
  removeTrack: mock((playlistId: string, trackId: string) => {
    const pl = playlistStore[playlistId];
    if (!pl) return false;
    const idx = pl.tracks.findIndex((t: any) => t.id === trackId);
    if (idx === -1) return false;
    pl.tracks.splice(idx, 1);
    return true;
  }),
  reorderTracks: mock(() => true),
  updateTrack: mock((playlistId: string, trackId: string, updates: any) => {
    const pl = playlistStore[playlistId];
    if (!pl) return null;
    const track = pl.tracks.find((t: any) => t.id === trackId);
    if (!track) return null;
    Object.assign(track, updates);
    return { ...track };
  }),
};

const mockLocutorService = {
  getActiveLocutorAtCurrentTime: mock(() => null),
  listLocutors: mock(() => []),
  listSchedules: mock(() => []),
};

const mockTorrentService = {
  listTorrents: mock(() => []),
  addTorrentUrl: mock(() => Promise.resolve({ id: "t1" })),
  deleteTorrent: mock(() => Promise.resolve(true)),
  getQueue: mock(() => ({
    name: "test-queue",
    client: {},
    close: () => Promise.resolve(),
    on: () => {},
    metaValues: { version: "bullmq-mock" },
  })),
  getQueueStats: mock(() => Promise.resolve({ active: 0, waiting: 0, completed: 0, failed: 0 })),
};
const mockTtsService = {};

const app = createApiRouter({
  configService: mockConfigService as any,
  libraryRepo: mockLibraryRepo as any,
  libraryService: mockLibraryService as any,
  liquidsoapService: mockLiquidsoapService as any,
  liquidsoapQueueService: mockLiquidsoapQueueService as any,
  playlistRepo: mockPlaylistRepo as any,
  locutorService: mockLocutorService as any,
  torrentService: mockTorrentService as any,
  musicDir: TEMP_DIR,
  distDir: TEMP_DIR,
  ttsService: mockTtsService as any,
});

beforeEach(() => {
  queueStore = [];
  ridCounter = 0;
  configStore = { ...mockConfig };
  bullMqJobs = [];
  bullMqJobIdCounter = 0;
  mockLiquidsoapQueueService.add.mockClear();
  mockLiquidsoapQueueService.addTts.mockClear();
  for (const pl of Object.values(playlistStore)) {
    pl.played = false;
  }
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

  test("GET /api/library", async () => {
    const res = await req("GET", "/api/library");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.songs).toHaveLength(2);
    expect(json.data.interludios).toHaveLength(1);
  });

  test("GET /api/library/track/:id - found", async () => {
    const res = await req("GET", "/api/library/track/s1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.title).toBe("Canción 1");
  });

  test("GET /api/library/track/:id - not found", async () => {
    const res = await req("GET", "/api/library/track/nonexistent");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/library/track/:id - not found", async () => {
    const res = await req("DELETE", "/api/library/track/nonexistent");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/library/track/:id - found", async () => {
    const res = await req("DELETE", "/api/library/track/s1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test("GET /api/library/rescan", async () => {
    const res = await req("GET", "/api/library/rescan");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.rescanned).toBe(true);
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
// QUEUE (via BullMQ)
// ============================================================
describe("Queue endpoints", () => {
  test("GET /api/stream/queue - empty", async () => {
    const res = await req("GET", "/api/stream/queue");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  test("POST /api/stream/queue - success with id", async () => {
    const res = await req("POST", "/api/stream/queue", { id: "s1" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data[0].jobId).toMatch(/^bmq-file-/);
    expect(json.data[0].type).toBe("song");
    expect(mockLiquidsoapQueueService.add).toHaveBeenCalledTimes(1);
  });

  test("POST /api/stream/queue - success with script", async () => {
    const res = await req("POST", "/api/stream/queue", { script: "Hola radio", voice: "es-ES-AlvaroNeural" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data[0].jobId).toMatch(/^bmq-tts-/);
    expect(json.data[0].type).toBe("interludio");
    expect(mockLiquidsoapQueueService.addTts).toHaveBeenCalledWith("Hola radio", "es-ES-AlvaroNeural");
  });

  test("POST /api/stream/queue - missing id and script returns 200 with empty data", async () => {
    const res = await req("POST", "/api/stream/queue", {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  test("POST /api/stream/queue - invalid id returns 400", async () => {
    const res = await req("POST", "/api/stream/queue", { id: "nonexistent" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("not found");
  });

  test("POST /api/stream/queue - multiple items preserve order", async () => {
    const res = await req("POST", "/api/stream/queue", [
      { id: "s1" },
      { script: "Anuncio", voice: "es-ES-AlvaroNeural" },
      { id: "s2" },
    ]);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(3);
    expect(json.data[0].type).toBe("song");
    expect(json.data[1].type).toBe("interludio");
    expect(json.data[2].type).toBe("song");
    expect(mockLiquidsoapQueueService.add).toHaveBeenCalledTimes(2);
    expect(mockLiquidsoapQueueService.addTts).toHaveBeenCalledTimes(1);
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
    await mockLiquidsoapService.queuePush("/music/songs/test.mp3");
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
    const res = await req("POST", "/api/stream/queue/insert", { index: 0, id: "s1" });
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

  test("GET /api/playlists - returns all playlists", async () => {
    const res = await req("GET", "/api/playlists");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.length).toBeGreaterThanOrEqual(4);
  });

  test("GET /api/playlists/:id - not found", async () => {
    const res = await req("GET", "/api/playlists/nonexistent");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("GET /api/playlists/:id - found includes tracks", async () => {
    const res = await req("GET", "/api/playlists/pl_songs");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.name).toBe("Songs Only");
    expect(json.data.tracks).toHaveLength(2);
  });

  test("PUT /api/playlists/:id - missing name", async () => {
    const res = await req("PUT", "/api/playlists/pl_songs", {});
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
    const originalName = playlistStore.pl_songs.name;
    const res = await req("PUT", "/api/playlists/pl_songs", { name: "Updated Name" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe("Updated Name");
    playlistStore.pl_songs.name = originalName;
  });

  test("DELETE /api/playlists/:id - not found", async () => {
    const res = await req("DELETE", "/api/playlists/nonexistent");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/playlists/:id - success", async () => {
    const res = await req("DELETE", "/api/playlists/pl_empty");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    playlistStore.pl_empty = { id: "pl_empty", name: "Empty", tracks: [], createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" };
  });

  test("POST /api/playlists/:id/tracks - missing title", async () => {
    const res = await req("POST", "/api/playlists/pl_songs/tracks", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/playlists/:id/tracks - playlist not found reports as failed", async () => {
    const res = await req("POST", "/api/playlists/nonexistent/tracks", { tracks: [{ title: "Test" }] });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.failed).toBe(1);
    expect(json.data.added).toBe(0);
    expect(json.data.results[0].error).toContain("Playlist not found");
  });

  test("POST /api/playlists/:id/tracks - success with single track", async () => {
    const res = await req("POST", "/api/playlists/pl_songs/tracks", { tracks: [{ title: "New Track" }] });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.added).toBe(1);
    expect(json.data.failed).toBe(0);
    expect(json.data.total).toBe(1);
  });

  test("POST /api/playlists/:id/tracks - success with multiple tracks", async () => {
    const res = await req("POST", "/api/playlists/pl_songs/tracks", {
      tracks: [
        { libraryTrackId: "s1" },
        { type: "interludio", title: "Saludo", script: "Hola" },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.added).toBe(2);
    expect(json.data.failed).toBe(0);
  });

  test("DELETE /api/playlists/:id/tracks/:trackId - not found", async () => {
    const res = await req("DELETE", "/api/playlists/pl_songs/tracks/nonexistent");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("DELETE /api/playlists/:id/tracks/:trackId - success", async () => {
    const res = await req("DELETE", "/api/playlists/pl_songs/tracks/pt1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    playlistStore.pl_songs.tracks.unshift({ id: "pt1", playlistId: "pl_songs", pos: 0, type: "song", file: "songs/cancion1.mp3", title: "Canción 1", artist: "Artist A", duration: 200, addedAt: "2024-01-01" });
  });

  test("PUT /api/playlists/:id/tracks/reorder - missing trackIds", async () => {
    const res = await req("PUT", "/api/playlists/pl_songs/tracks/reorder", {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("PUT /api/playlists/:id/tracks/reorder - success", async () => {
    const res = await req("PUT", "/api/playlists/pl_songs/tracks/reorder", { trackIds: ["pt1", "pt2"] });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test("POST /api/playlists/:id/play - playlist not found", async () => {
    const res = await req("POST", "/api/playlists/nonexistent/play");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test("POST /api/playlists/:id/play - empty playlist", async () => {
    const res = await req("POST", "/api/playlists/pl_empty/play");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});

// ============================================================
// PLAYLIST PLAY (BullMQ integration, order preservation)
// ============================================================
describe("POST /api/playlists/:id/play with BullMQ", () => {
  test("queues file tracks via BullMQ add()", async () => {
    const res = await req("POST", "/api/playlists/pl_songs/play");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.queued).toBe(2);
    expect(json.data.skipped).toBe(0);
    expect(json.data.failed).toBe(0);
    expect(json.data.total).toBe(2);
    await new Promise((r) => setTimeout(r, 5));
    expect(mockLiquidsoapQueueService.add).toHaveBeenCalledTimes(2);
    expect(mockLiquidsoapQueueService.addTts).toHaveBeenCalledTimes(0);
    expect(mockLiquidsoapQueueService.add).toHaveBeenNthCalledWith(1, "/music/songs/cancion1.mp3");
    expect(mockLiquidsoapQueueService.add).toHaveBeenNthCalledWith(2, "/music/songs/cancion2.mp3");
    for (const r of json.data.results) {
      expect(r.status).toBe("queued");
    }
  });

  test("queues script tracks via BullMQ addTts()", async () => {
    const res = await req("POST", "/api/playlists/pl_scripts/play");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.queued).toBe(2);
    expect(json.data.skipped).toBe(0);
    expect(json.data.failed).toBe(0);
    expect(json.data.total).toBe(2);
    await new Promise((r) => setTimeout(r, 5));
    expect(mockLiquidsoapQueueService.add).toHaveBeenCalledTimes(0);
    expect(mockLiquidsoapQueueService.addTts).toHaveBeenCalledTimes(2);
    expect(mockLiquidsoapQueueService.addTts).toHaveBeenNthCalledWith(1, "Bienvenidos a la radio", undefined);
    expect(mockLiquidsoapQueueService.addTts).toHaveBeenNthCalledWith(2, "Gracias por escuchar", undefined);
    for (const r of json.data.results) {
      expect(r.status).toBe("queued");
    }
  });

  test("queues mixed playlist in correct order", async () => {
    const res = await req("POST", "/api/playlists/pl_mixed/play");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.queued).toBe(4);
    expect(json.data.skipped).toBe(0);
    expect(json.data.failed).toBe(0);

    await new Promise((r) => setTimeout(r, 5));
    expect(mockLiquidsoapQueueService.add).toHaveBeenCalledTimes(3);
    expect(mockLiquidsoapQueueService.addTts).toHaveBeenCalledTimes(1);
    expect(mockLiquidsoapQueueService.add.mock.calls[0][0]).toBe("/music/songs/cancion1.mp3");
    expect(mockLiquidsoapQueueService.addTts.mock.calls[0][0]).toBe("Bienvenidos");
    expect(mockLiquidsoapQueueService.add.mock.calls[1][0]).toBe("/music/songs/cancion2.mp3");
    expect(mockLiquidsoapQueueService.add.mock.calls[2][0]).toBe("/music/interludios/pausa1.mp3");

    expect(json.data.results).toHaveLength(4);
    expect(json.data.results[0].title).toBe("Canción 1");
    expect(json.data.results[0].jobId).toMatch(/^bmq-file-/);
    expect(json.data.results[1].title).toBe("Saludo");
    expect(json.data.results[1].jobId).toMatch(/^bmq-tts-/);
    expect(json.data.results[2].title).toBe("Canción 2");
    expect(json.data.results[2].jobId).toMatch(/^bmq-file-/);
    expect(json.data.results[3].title).toBe("Pausa 1");
    expect(json.data.results[3].jobId).toMatch(/^bmq-file-/);
    expect(json.data.results[3].pos).toBe(3);
  });

  test("accepts voice parameter for TTS", async () => {
    const res = await req("POST", "/api/playlists/pl_scripts/play", { voice: "es-ES-CarolinaNeural" });
    expect(res.status).toBe(200);
    expect(mockLiquidsoapQueueService.addTts).toHaveBeenCalledWith("Bienvenidos a la radio", "es-ES-CarolinaNeural");
    expect(mockLiquidsoapQueueService.addTts).toHaveBeenCalledWith("Gracias por escuchar", "es-ES-CarolinaNeural");
  });

  test("play with mode='ahora' clears queue and plays", async () => {
    const res = await req("POST", "/api/playlists/pl_songs/play", { mode: "ahora" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.mode).toBe("ahora");
    expect(json.data.queued).toBe(2);
    expect(mockLiquidsoapQueueService.add).toHaveBeenCalledTimes(2);
    expect(mockLiquidsoapService.queueClear).toHaveBeenCalled();
  });

  test("play with mode='encolar' does not clear queue", async () => {
    mockLiquidsoapService.queueClear.mockClear();
    const res = await req("POST", "/api/playlists/pl_songs/play", { mode: "encolar" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.mode).toBe("encolar");
    expect(json.data.queued).toBe(2);
    expect(mockLiquidsoapService.queueClear).not.toHaveBeenCalled();
  });

  test("returns jobId for every queued track", async () => {
    const res = await req("POST", "/api/playlists/pl_mixed/play");
    const json = await res.json();
    for (const r of json.data.results) {
      expect(r.jobId).toBeDefined();
      expect(typeof r.jobId).toBe("string");
      expect(r.jobId.length).toBeGreaterThan(0);
    }
  });

  test("interludio with both file and script uses file path (not TTS)", async () => {
    const res = await req("POST", "/api/playlists/pl_mixed/play");
    expect(res.status).toBe(200);
    const calls = bullMqJobs.filter((j) => j.type === "file");
    const fileUrls = calls.map((c) => c.data.filepath);
    expect(fileUrls).toContain("/music/interludios/pausa1.mp3");
  });

  test("reports failed tracks with error message when add() throws", async () => {
    mockLiquidsoapQueueService.add.mockImplementationOnce(() => Promise.reject(new Error("BullMQ connection refused")));
    const res = await req("POST", "/api/playlists/pl_songs/play");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.queued).toBe(1);
    expect(json.data.failed).toBe(1);
    expect(json.data.total).toBe(2);
    const failed = json.data.results.find((r: any) => r.status === "failed");
    expect(failed).toBeDefined();
    expect(failed.error).toBe("BullMQ connection refused");
    expect(failed.title).toBe("Canción 1");
    const queued = json.data.results.find((r: any) => r.status === "queued");
    expect(queued).toBeDefined();
    expect(queued.title).toBe("Canción 2");
  });

  test("reports failed tracks with error message when addTts() throws", async () => {
    mockLiquidsoapQueueService.addTts.mockImplementationOnce(() => Promise.reject(new Error("TTS synthesis quota exceeded")));
    const res = await req("POST", "/api/playlists/pl_scripts/play");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.failed).toBe(1);
    expect(json.data.queued).toBe(1);
    const failed = json.data.results.find((r: any) => r.status === "failed");
    expect(failed.error).toBe("TTS synthesis quota exceeded");
  });

  test("marks track as skipped when it has no file and no script", async () => {
    const badPlaylist = {
      id: "pl_bad", name: "Bad Tracks", tracks: [
        { id: "pt_bad1", playlistId: "pl_bad", pos: 0, type: "song", file: null, title: "Empty Track", duration: 0, addedAt: "2024-01-01" },
        { id: "pt_bad2", playlistId: "pl_bad", pos: 1, type: "interludio", file: null, title: "No script either", duration: 0, addedAt: "2024-01-01" },
      ], createdAt: "", updatedAt: "",
    };
    const originalGet = mockPlaylistRepo.get;
    mockPlaylistRepo.get.mockImplementationOnce((id: string) => id === "pl_bad" ? badPlaylist : originalGet(id));
    const res = await req("POST", "/api/playlists/pl_bad/play");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.queued).toBe(0);
    expect(json.data.skipped).toBe(2);
    expect(json.data.failed).toBe(0);
    expect(json.data.results[0].error).toBe("no file or script");
    expect(json.data.results[1].error).toBe("no file or script");
  });
});
