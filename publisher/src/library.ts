import { readdirSync, statSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join, extname, basename } from "path";
import { spawnSync } from "child_process";
import type { Track, LibraryStats } from "./types";
import { getAllLibraryTracks as dbGetAll, getLibraryTrack, getLibraryTrackByUrl, upsertLibraryTrack, removeLibraryTrack as dbRemove, getLibraryStats as dbStats, getDB } from "./db";
import { queueClear } from "./liquidsoap";

const MUSIC_DIR = process.env.MUSIC_DIR || "/app/music";
const SONGS_DIR = join(MUSIC_DIR, "songs");
const INTERLUDIOS_DIR = join(MUSIC_DIR, "interludios");
const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a)$/i;

function ensureDirs() {
  if (!existsSync(SONGS_DIR)) mkdirSync(SONGS_DIR, { recursive: true });
  if (!existsSync(INTERLUDIOS_DIR)) mkdirSync(INTERLUDIOS_DIR, { recursive: true });
}

function getAudioMetadata(filePath: string): { duration: number; artist: string; album: string; title: string; spotifyUrl: string } {
  const result = { duration: 0, artist: "", album: "", title: "", spotifyUrl: "" };
  try {
    const meta = spawnSync("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration:format_tags=artist,album,title",
      "-of", "default=noprint_wrappers=1",
      filePath,
    ], { timeout: 8000 });
    if (meta.status === 0) {
      for (const line of meta.stdout.toString().trim().split("\n")) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        let key = line.substring(0, eq).trim();
        const val = line.substring(eq + 1).trim();
        if (key.startsWith("TAG:")) key = key.substring(4);
        if (key === "duration") result.duration = parseFloat(val) || 0;
        if (key === "artist") result.artist = val;
        if (key === "album") result.album = val;
        if (key === "title") result.title = val;
        if (key === "WOAS" || key === "woas") result.spotifyUrl = val;
      }
    }
  } catch {}
  return result;
}

function scanAndUpsert(dir: string, type: "song" | "interludio") {
  const prefix = type === "song" ? "songs" : "interludios";
  const files = readdirSync(dir).filter((f) => AUDIO_EXTENSIONS.test(f));
  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    const key = `${prefix}/${file}`;
    const existing = dbGetAll(type).find((t) => t.file === key);
    if (existing && new Date(stat.mtime.toISOString()) <= new Date(existing.addedAt)) continue;
    const name = basename(file, extname(file));
    const meta = getAudioMetadata(filePath);
    upsertLibraryTrack({
      file: key,
      type,
      title: meta.title || name,
      artist: meta.artist,
      album: meta.album,
      duration: meta.duration || Math.floor(stat.size / (192 * 1000 / 8)),
      spotify_url: meta.spotifyUrl,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    });
  }
}

function watchDir(dir: string, type: "song" | "interludio") {
  try {
    const fs = require("fs");
    fs.watch(dir, (event: string, filename: string | null) => {
      if (!filename || !AUDIO_EXTENSIONS.test(filename)) return;
      setTimeout(() => {
        const filePath = join(dir, filename);
        if (!existsSync(filePath)) {
          const key = `${type === "song" ? "songs" : "interludios"}/${filename}`;
          dbRemove(key);
          console.log(`[library] Removed: ${key}`);
          return;
        }
        scanAndUpsert(dir, type);
        console.log(`[library] Scanned: ${filename}`);
      }, 1000);
    });
    console.log(`[library] Watching: ${dir}`);
  } catch {}
}

export function initLibrary() {
  ensureDirs();
  scanAndUpsert(SONGS_DIR, "song");
  scanAndUpsert(INTERLUDIOS_DIR, "interludio");
  watchDir(SONGS_DIR, "song");
  watchDir(INTERLUDIOS_DIR, "interludio");
  console.log(`[library] Initialized: ${dbStats().totalSongs} songs, ${dbStats().totalInterludios} interludios`);
}

export function listSongs(): Track[] {
  return dbGetAll("song");
}

export function listInterludios(): Track[] {
  return dbGetAll("interludio");
}

export function getAllTracks(): Track[] {
  return dbGetAll();
}

export function getTrackByFile(file: string): Track | null {
  return getLibraryTrack(file);
}

export function deleteTrack(file: string): boolean {
  const fullPath = join(MUSIC_DIR, file);
  if (!existsSync(fullPath)) {
    dbRemove(file);
    return true;
  }
  try {
    unlinkSync(fullPath);
    dbRemove(file);
    queueClear();
    getDB().run("DELETE FROM timeline_tracks WHERE file = ?", file);
    console.log(`[library] Deleted: ${file}`);
    return true;
  } catch {
    return false;
  }
}

export function getLibraryStats(): LibraryStats {
  return dbStats();
}

export function scanLibrary() {
  ensureDirs();
  scanAndUpsert(SONGS_DIR, "song");
  scanAndUpsert(INTERLUDIOS_DIR, "interludio");
  return dbStats();
}

export function getTrackByUrl(url: string): Track | null {
  return getLibraryTrackByUrl(url);
}

export function getMusicDir(): string {
  return MUSIC_DIR;
}
