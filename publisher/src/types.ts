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

export interface Timeline {
  tracks: Track[];
  currentIndex: number;
  isPlaying: boolean;
  updatedAt: string;
}

export interface StreamStatus {
  connected: boolean;
  playing: boolean;
  currentTrack: string | null;
  remaining: number;
  uptime: number;
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

export interface LibraryStats {
  totalSongs: number;
  totalInterludios: number;
  totalSizeBytes: number;
  totalDurationSeconds: number;
}

export interface ApiResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}
