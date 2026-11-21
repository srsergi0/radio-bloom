export interface Track {
  id: string;
  type: "song" | "interludio";
  file: string;
  title: string;
  artist?: string;
  album?: string;
  duration: number;
  spotifyUrl?: string;
  addedAt: string;
  mtime?: string;
  lastPlayedAt?: string;
  script?: string;
}

export interface StreamStatus {
  connected: boolean;
  playing: boolean;
  currentTrack: string | null;
  artist: string | null;
  title: string | null;
  uptime: string;
  duration: number;
  elapsed: number;
  metadata?: Record<string, string>;
  activeLocutor?: {
    id: string;
    name: string;
    voice: string;
  } | null;
}

export interface SystemConfig {
  streamBitrate: number;
  streamSampleRate: number;
  crossfadeDuration: number;
  playlistReloadSeconds: number;
}

export interface Playlist {
  id: string;
  name: string;
  played: boolean;
  description?: string;
  locutorId?: string;
  tracks: PlaylistTrack[];
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistTrack {
  id: string;
  playlistId: string;
  pos: number;
  type: "song" | "interludio";
  file?: string;
  title: string;
  artist?: string;
  duration: number;
  spotifyUrl?: string;
  script?: string;
  addedAt: string;
}

export interface ApiResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface Locutor {
  id: string;
  name: string;
  voice: string;
  personality: string;
  isActive: boolean;
  isDefault: boolean;
}

export interface LocutorSchedule {
  id: string;
  locutorId: string;
  type: "daily" | "weekly";
  dayOfWeek: number | null; // 0 = Sunday, 1 = Monday ... 6 = Saturday (null if type is 'daily')
  startHour: string; // "HH:MM" e.g. "14:00"
  duration: number; // in minutes
}

// ============================================================
// Listener API (/api/live/*) — public, read-only contract
// ============================================================

export type LiveSource = "autodj" | "queue" | "live";
export type LiveTrackType = "song" | "interludio";

export interface LiveTrack {
  key: string;
  title: string;
  artist: string;
  album: string | null;
  duration: number; // seconds
  elapsed: number; // seconds at serverTime
  startedAt: number; // epoch ms
  coverUrl: string | null;
  spotifyUrl: string | null;
  type: LiveTrackType;
}

/** Dedication attached to the current track when it was a listener request. */
export interface LiveTrackRequest {
  name: string | null;
  message: string | null;
}

/** `track` as sent in /api/live/now (LiveTrack + hearts + request). */
export interface LiveNowTrack extends LiveTrack {
  hearts: number;
  request: LiveTrackRequest | null;
}

export interface LiveShow {
  start: string; // "HH:MM" (America/Lima)
  duration: number; // minutes
  endsAt: number; // epoch ms
}

export interface LiveHost {
  id: number;
  name: string;
  voice: string;
  personality: string; // first ~180 chars
  show: LiveShow | null;
}

export interface LiveListeners {
  current: number;
  opus: number;
  mp3: number;
  peakToday: number;
}

export interface LiveStreamInfo {
  opus: string;
  mp3: string;
  bitrateKbps: number;
  /**
   * Live edge of the Opus stream: position (s, from its Ogg granule) of the newest page the
   * publisher received, and the server time it arrived. Clients compare it with the playback
   * position of their <audio> to know exactly how far behind live they are.
   */
  livePosition?: { seconds: number; at: number } | null;
}

export interface LiveUpNextItem {
  title: string;
  artist: string;
  type: LiveTrackType;
  coverUrl: string | null;
}

export interface LiveNowPayload {
  station: { name: string; city: string; timezone: string };
  onAir: { isLive: boolean; source: LiveSource };
  track: LiveNowTrack | null;
  host: LiveHost | null;
  listeners: LiveListeners;
  stream: LiveStreamInfo;
  upNext: LiveUpNextItem[];
  serverTime: number;
}

export interface LiveHistoryItem {
  key: string;
  hearts: number;
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  duration: number;
  playedAt: number; // epoch ms
}

export interface LiveScheduleSlot {
  locutorId: number;
  hostName: string;
  voice: string;
  personality: string;
  dayOfWeek: number; // 0 = Sunday ... 6 = Saturday
  start: string; // "HH:MM"
  duration: number; // minutes
  isDefault: boolean;
}

export interface LiveSchedulePayload {
  timezone: string;
  now: { dayOfWeek: number; minute: number };
  slots: LiveScheduleSlot[];
}
