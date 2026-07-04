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

export interface FileTreeNode {
  name: string;
  path: string;
  children?: FileTreeNode[];
  tracks?: Track[];
}

export interface LibraryTree {
  songs: FileTreeNode;
  interludios: FileTreeNode;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
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

export interface StreamQueueItem {
  rid: string;
  artist: string;
  title: string;
  type?: "song" | "interludio";
  script?: string;
  pending?: boolean;
}
