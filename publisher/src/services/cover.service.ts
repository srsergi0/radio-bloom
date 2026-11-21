import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { spotifyGetTrack } from "../infrastructure/spotify.client";
import type { LibraryRepository } from "../repositories/sqlite/library.repo";
import type { PlayHistoryRepository } from "../repositories/sqlite/play-history.repo";
import { coverUrlForKey, fileTrackKey, isValidTrackKey, toDbPath } from "./live.mapper";

const FFMPEG_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_EXTRACTIONS = 2;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const LIBRARY_INDEX_TTL_MS = 60_000;

/**
 * Album art for the listener API. Lazily extracts the embedded picture with ffmpeg
 * (normalised to a ≤600px JPEG), falls back to Spotify album art when the library row
 * has a Spotify URL and credentials exist, and caches the result on disk:
 *   <coversDir>/<key>.jpg   — art found
 *   <coversDir>/<key>.miss  — known miss (coverUrl → null)
 */
export class CoverService {
  private readonly hits = new Set<string>();
  private readonly misses = new Set<string>();
  private readonly keyToFile = new Map<string, string>(); // key → library path ("songs/..")
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private libraryIndexBuiltAt = 0;
  private running = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly musicDir: string,
    private readonly coversDir: string,
    private readonly libraryRepo: LibraryRepository,
    private readonly historyRepo: PlayHistoryRepository
  ) {
    try {
      if (!existsSync(coversDir)) mkdirSync(coversDir, { recursive: true });
      for (const name of readdirSync(coversDir)) {
        const m = name.match(/^([a-f0-9]{12})\.(jpg|miss)$/);
        if (!m) continue;
        (m[2] === "jpg" ? this.hits : this.misses).add(m[1]);
      }
    } catch (err: any) {
      console.error("[CoverService] Cannot prepare covers dir:", err.message);
    }
  }

  /** Remember which file a key refers to (called for every track the live API exposes). */
  public register(file: string): string {
    const dbPath = toDbPath(file);
    const key = fileTrackKey(dbPath);
    this.keyToFile.set(key, dbPath);
    return key;
  }

  /** coverUrl for payloads: URL if art exists or hasn't been attempted yet; null on known miss. */
  public coverUrlFor(key: string): string | null {
    return this.misses.has(key) ? null : coverUrlForKey(key);
  }

  public isKnownMiss(key: string): boolean {
    return this.misses.has(key);
  }

  /** Ensures the cover for a key is resolved (extracts once). Returns the jpg path or null. */
  public async ensure(key: string): Promise<string | null> {
    if (!isValidTrackKey(key)) return null;
    const cached = join(this.coversDir, `${key}.jpg`);
    if (this.hits.has(key)) {
      if (existsSync(cached)) return cached;
      this.hits.delete(key);
    }
    if (this.misses.has(key)) return null;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const job = this.resolveCover(key, cached).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  private async resolveCover(key: string, target: string): Promise<string | null> {
    const dbPath = this.lookupFile(key);
    if (!dbPath) return null; // unknown key: don't record a miss (could become known later)

    const absPath = resolve(this.musicDir, dbPath);
    if (!absPath.startsWith(resolve(this.musicDir) + sep) || !existsSync(absPath)) return null;

    let bytes = await this.withSlot(() => this.extractEmbedded(absPath));
    if (!bytes) bytes = await this.fetchSpotifyArt(dbPath);

    if (!bytes) {
      this.misses.add(key);
      await writeFile(join(this.coversDir, `${key}.miss`), "").catch(() => {});
      return null;
    }

    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, target);
      this.hits.add(key);
      return target;
    } catch (err: any) {
      console.error("[CoverService] Cannot write cover:", err.message);
      await unlink(tmp).catch(() => {});
      return null;
    }
  }

  private lookupFile(key: string): string | null {
    const known = this.keyToFile.get(key);
    if (known) return known;

    const fromHistory = this.historyRepo.findFileByKey(key);
    if (fromHistory) {
      this.keyToFile.set(key, toDbPath(fromHistory));
      return toDbPath(fromHistory);
    }

    // Rebuild a key index of the whole library at most once per TTL
    if (Date.now() - this.libraryIndexBuiltAt > LIBRARY_INDEX_TTL_MS) {
      this.libraryIndexBuiltAt = Date.now();
      for (const t of this.libraryRepo.getAllTracks("song")) this.register(t.file);
      return this.keyToFile.get(key) ?? null;
    }
    return null;
  }

  private async extractEmbedded(absPath: string): Promise<Uint8Array | null> {
    try {
      const proc = Bun.spawn(
        [
          "ffmpeg",
          "-v",
          "error",
          "-nostdin",
          "-i",
          absPath,
          "-an",
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          "scale='min(600,iw)':-2",
          "-pix_fmt",
          "yuvj420p",
          "-q:v",
          "3",
          "-f",
          "mjpeg",
          "pipe:1",
        ],
        { stdout: "pipe", stderr: "ignore", stdin: "ignore" }
      );
      const timer = setTimeout(() => proc.kill(), FFMPEG_TIMEOUT_MS);
      const [buf, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
      clearTimeout(timer);
      if (code !== 0 || buf.byteLength < 100 || buf.byteLength > MAX_COVER_BYTES) return null;
      return new Uint8Array(buf);
    } catch (err: any) {
      console.error("[CoverService] ffmpeg failed:", err.message);
      return null;
    }
  }

  private async fetchSpotifyArt(dbPath: string): Promise<Uint8Array | null> {
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) return null;
    const lib = this.libraryRepo.getTrackByFile(dbPath);
    if (!lib?.spotifyUrl) return null;
    try {
      const sp = await spotifyGetTrack(lib.spotifyUrl);
      if (!sp?.albumArt) return null;
      const res = await fetch(sp.albumArt, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok || !(res.headers.get("content-type") || "").startsWith("image/")) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 100 || buf.byteLength > MAX_COVER_BYTES) return null;
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= MAX_CONCURRENT_EXTRACTIONS) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiters.shift()?.();
    }
  }
}
