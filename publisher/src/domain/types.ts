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

export interface DownloadJob {
  id: string;
  url: string;
  status: "queued" | "downloading" | "done" | "error";
  result?: Track;
  error?: string;
  startedAt: string;
  completedAt?: string;
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

export interface LiveStatus {
  active: boolean;
  connected: boolean;
}

export interface ApiResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}
