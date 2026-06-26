import { loadTimelineMeta, saveTimelineMeta, loadTracks, addTrack as dbAddTrack, insertTrack as dbInsertTrack, updateTrack as dbUpdateTrack, removeTrack as dbRemoveTrack, reorderTracks as dbReorder, clearTimeline as dbClear, getTrackById as dbGetById, getDB } from "./db";
import type { Track } from "./types";

export function loadTimeline() {
  const meta = loadTimelineMeta();
  const tracks = loadTracks();
  return { tracks, ...meta };
}

export function saveTimeline(data: { tracks?: Track[]; currentIndex?: number; isPlaying?: boolean }) {
  const d = getDB();
  if (data.tracks) {
    d.transaction(() => {
      d.run("DELETE FROM timeline_tracks");
      const insert = d.prepare("INSERT INTO timeline_tracks (id, pos, type, file, title, artist, album, duration, spotify_url, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      data.tracks.forEach((t, i) => insert.run(t.id, i, t.type, t.file, t.title, t.artist || "", t.album || "", t.duration, t.spotifyUrl || "", t.addedAt));
    })();
  }
  const meta = loadTimelineMeta();
  saveTimelineMeta(data.currentIndex ?? meta.currentIndex, data.isPlaying ?? meta.isPlaying);
  return loadTimeline();
}

export function addTrack(track: Track) {
  const tracks = dbAddTrack(track);
  const meta = loadTimelineMeta();
  return { tracks, ...meta };
}

export function insertTrack(index: number, track: Track) {
  const tracks = dbInsertTrack(index, track);
  const meta = loadTimelineMeta();
  return { tracks, ...meta };
}

export function updateTrack(id: string, updates: Partial<Track>): Track | null {
  return dbUpdateTrack(id, updates);
}

export function removeTrack(id: string) {
  const tracks = dbRemoveTrack(id);
  const meta = loadTimelineMeta();
  return { tracks, ...meta };
}

export function reorderTracks(fromIndex: number, toIndex: number) {
  const tracks = dbReorder(fromIndex, toIndex);
  const meta = loadTimelineMeta();
  return { tracks, ...meta };
}

export function setCurrentIndex(index: number) {
  const meta = loadTimelineMeta();
  const tracks = loadTracks();
  const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
  saveTimelineMeta(safeIndex, meta.isPlaying);
  return { tracks, currentIndex: safeIndex, isPlaying: meta.isPlaying, updatedAt: new Date().toISOString() };
}

export function clearTimeline() {
  dbClear();
  saveTimelineMeta(0, false);
  return { tracks: [] as Track[], currentIndex: 0, isPlaying: false, updatedAt: new Date().toISOString() };
}

export function getCurrentTrack(): Track | null {
  const meta = loadTimelineMeta();
  const tracks = loadTracks();
  if (tracks.length === 0) return null;
  return tracks[meta.currentIndex] || null;
}

export function getTrackById(id: string): Track | null {
  return dbGetById(id);
}

export function nextTrack(): Track | null {
  const meta = loadTimelineMeta();
  const tracks = loadTracks();
  if (tracks.length === 0) return null;
  const nextIdx = (meta.currentIndex + 1) % tracks.length;
  saveTimelineMeta(nextIdx, meta.isPlaying);
  return tracks[nextIdx];
}
