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
