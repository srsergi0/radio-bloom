import { spawnSync } from "child_process";
import { createConnection, type Socket } from "net";

const LIQUIDSOAP_HOST = process.env.LIQUIDSOAP_HOST || "localhost";
const LIQUIDSOAP_TELNET_PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || "1234");

let connected = false;
let reconnectTimer: Timer | null = null;
let durationCache = new Map<string, { duration: number; cachedAt: number }>();
const DURATION_CACHE_TTL = 3600000;
let lastQueuedRid: string | null = null;

function keepAlive() {
  const s = createConnection(LIQUIDSOAP_TELNET_PORT, LIQUIDSOAP_HOST);
  s.on("connect", () => {
    connected = true;
    s.end();
  });
  s.on("error", () => {});
  s.on("close", () => {
    connected = false;
  });
}

export function sendCommand(cmd: string, timeoutMs = 10000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const s = createConnection(LIQUIDSOAP_TELNET_PORT, LIQUIDSOAP_HOST);
    const lines: string[] = [];
    let buf = "";
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      s.destroy();
      reject(new Error("Command timeout"));
    }, timeoutMs);

    s.on("connect", () => {
      connected = true;
      s.write(cmd + "\n");
    });

    s.on("data", (data) => {
      buf += data.toString();
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.substring(0, idx).trim();
        buf = buf.substring(idx + 1);
        if (line === "END") {
          done = true;
          clearTimeout(timer);
          s.end();
          resolve(lines);
          return;
        }
        if (line !== "") {
          lines.push(line);
        }
      }
    });

    s.on("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    s.on("close", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        if (lines.length > 0) {
          resolve(lines);
        } else {
          reject(new Error("Connection closed"));
        }
      }
    });
  });
}

function ensureConnected() {
  if (!connected) {
    keepAlive();
  }
}

export async function skipTrack(): Promise<void> {
  await sendCommand("queue.flush_and_skip");
}

export async function clearAndPush(filepath: string): Promise<string | null> {
  await sendCommand("queue.clear");
  await new Promise((r) => setTimeout(r, 200));
  return queuePush(filepath);
}

export async function queueLength(): Promise<number> {
  try {
    const lines = await sendCommand("queue.queue");
    if (lines.length === 0) return 0;
    return lines[0].split(/\s+/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

export async function pausePlayback(): Promise<void> {
  await sendCommand("output.harbor.stop");
}

export async function startPlayback(): Promise<void> {
  await sendCommand("output.harbor.start");
}

export async function getCurrentRequestId(): Promise<string | null> {
  try {
    const lines = await sendCommand("request.on_air");
    const allRids: string[] = [];
    for (const line of lines) {
      for (const part of line.trim().split(/\s+/)) {
        if (part !== "") allRids.push(part);
      }
    }
    if (allRids.length === 0) return null;
    const sorted = allRids.sort((a, b) => parseInt(b) - parseInt(a));
    const rid = sorted[0];
    if (lastQueuedRid && rid !== lastQueuedRid) lastQueuedRid = null;
    return rid;
  } catch {
    return null;
  }
}

export async function getRequestMetadata(rid: string): Promise<Record<string, string>> {
  try {
    const lines = await sendCommand(`request.metadata ${rid}`);
    const meta: Record<string, string> = {};
    for (const line of lines) {
      const eqIndex = line.indexOf("=");
      if (eqIndex > 0) {
        const key = line.substring(0, eqIndex).trim();
        let value = line.substring(eqIndex + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        meta[key] = value;
      }
    }
    return meta;
  } catch {
    return {};
  }
}

function getFileDuration(filepath: string): number {
  const MUSIC_MOUNT = process.env.MUSIC_MOUNT || "/app/music";
  const cached = durationCache.get(filepath);
  if (cached && Date.now() - cached.cachedAt < DURATION_CACHE_TTL) {
    return cached.duration;
  }

  const localPath = filepath.replace(/^\/music\//, `${MUSIC_MOUNT}/`);

  try {
    const result = spawnSync("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      localPath,
    ], { timeout: 5000 });

    if (result.status === 0) {
      const dur = parseFloat(result.stdout.toString().trim());
      if (!isNaN(dur) && dur > 0) {
        durationCache.set(filepath, { duration: dur, cachedAt: Date.now() });
        return dur;
      }
    }
  } catch {}
  return 0;
}

export async function getStreamStatus() {
  try {
    const rid = await getCurrentRequestId();

    if (!rid) {
      return {
        connected,
        playing: false,
        currentTrack: null,
        artist: null,
        title: null,
        uptime: "0",
        duration: 0,
        elapsed: 0,
        metadata: {},
      };
    }

    const [meta, uptimeLines] = await Promise.all([
      getRequestMetadata(rid).catch(() => ({})),
      sendCommand("uptime").catch(() => ["0"]),
    ]);

    let elapsed = 0;
    if (meta.on_air_timestamp) {
      const startTime = parseFloat(meta.on_air_timestamp);
      if (!isNaN(startTime)) {
        elapsed = Math.floor((Date.now() / 1000) - startTime);
      }
    }

    let duration = 0;
    const filename = meta.filename || meta.initial_uri || "";
    if (filename) {
      duration = getFileDuration(filename);
    }

    return {
      connected,
      playing: true,
      currentTrack: rid,
      artist: meta.artist || null,
      title: meta.title || meta.filename || null,
      uptime: uptimeLines[0] || "0",
      duration,
      elapsed,
      metadata: meta,
    };
  } catch {
    return {
      connected: false,
      playing: false,
      currentTrack: null,
      artist: null,
      title: null,
      uptime: "0",
      duration: 0,
      elapsed: 0,
    };
  }
}

export async function queuePush(filepath: string): Promise<string | null> {
  try {
    const lines = await sendCommand(`queue.push ${filepath}`);
    const rid = lines[0]?.trim() || null;
    if (rid) lastQueuedRid = rid;
    return rid;
  } catch {
    return null;
  }
}

export async function queueList(): Promise<{ rid: string; artist: string; title: string }[]> {
  try {
    const lines = await sendCommand("queue.queue");
    if (lines.length === 0) return [];
    const rids = lines[0].split(/\s+/).filter(Boolean);
    const items: { rid: string; artist: string; title: string }[] = [];
    for (const rid of rids) {
      const meta = await getRequestMetadata(rid).catch(() => ({}));
      items.push({
        rid,
        artist: meta.artist || "",
        title: meta.title || meta.filename || rid,
      });
    }
    return items;
  } catch {
    return [];
  }
}

export async function queueRemove(rid: string): Promise<boolean> {
  try {
    const lines = await sendCommand("queue.queue");
    if (lines.length === 0) return false;
    const queued = lines[0].split(/\s+/).filter(Boolean);
    const idx = queued.indexOf(rid);
    if (idx === -1) return false;

    const uris: string[] = [];
    for (const r of queued) {
      const meta = await getRequestMetadata(r).catch(() => ({}));
      uris.push(meta.initial_uri || meta.filename || "");
    }
    if (idx >= uris.length) return false;
    uris.splice(idx, 1);
    await sendCommand("queue.clear");
    await new Promise((r) => setTimeout(r, 500));
    for (const uri of uris) {
      if (uri) await queuePush(uri).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

export async function queueInsert(index: number, filepath: string): Promise<boolean> {
  try {
    const lines = await sendCommand("queue.queue");
    const queued = lines.length > 0 ? lines[0].split(/\s+/).filter(Boolean) : [];
    const uris: string[] = [];
    for (const r of queued) {
      const meta = await getRequestMetadata(r).catch(() => ({}));
      uris.push(meta.initial_uri || meta.filename || "");
    }
    const safeIndex = Math.max(0, Math.min(index, uris.length));
    uris.splice(safeIndex, 0, filepath);
    await sendCommand("queue.clear");
    await new Promise((r) => setTimeout(r, 500));
    for (const uri of uris) {
      if (uri) await queuePush(uri).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

export async function queueClear(): Promise<void> {
  try {
    await sendCommand("queue.clear");
  } catch {}
}

export async function playFileNow(filepath: string): Promise<boolean> {
  try {
    const rid = await queuePush(filepath);
    if (!rid) return false;
    await new Promise((r) => setTimeout(r, 1000));
    await sendCommand("queue.skip");
    return true;
  } catch {
    return false;
  }
}

export async function reloadPlaylist(): Promise<void> {
  await sendCommand("reload");
}

export function initLiquidsoap(): void {
  connected = true;
}

export function isLiquidsoapConnected(): boolean {
  return connected;
}
