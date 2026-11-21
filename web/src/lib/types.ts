// Contrato de la API pública de escucha (publisher /api/live/*)

export interface LiveTrack {
  key: string;
  title: string;
  artist: string;
  album: string | null;
  duration: number;
  elapsed: number;
  startedAt: number;
  coverUrl: string | null;
  spotifyUrl: string | null;
  type: "song" | "interludio";
  hearts?: number;
  request?: { name: string | null; message: string | null } | null;
}

export interface LiveHost {
  id: number;
  name: string;
  voice: string;
  personality: string;
  show: { start: string; duration: number; endsAt: number } | null;
}

export interface Listeners {
  current: number;
  opus: number;
  mp3: number;
  peakToday: number;
}

export interface NowPayload {
  station: { name: string; city: string; timezone: string };
  onAir: { isLive: boolean; source: "autodj" | "queue" | "live" };
  track: LiveTrack | null;
  host: LiveHost | null;
  listeners: Listeners;
  stream: { opus: string; mp3: string; bitrateKbps: number };
  upNext: Array<{ title: string; artist: string; type: "song" | "interludio"; coverUrl: string | null }>;
  serverTime: number;
}

export interface HistoryItem {
  key?: string;
  hearts?: number;
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  duration: number;
  playedAt: number;
}

export interface ScheduleSlot {
  locutorId: number;
  hostName: string;
  voice: string;
  personality: string;
  dayOfWeek: number;
  start: string;
  duration: number;
  isDefault: boolean;
}

export interface SchedulePayload {
  timezone: string;
  now: { dayOfWeek: number; minute: number };
  slots: ScheduleSlot[];
}

export interface SearchResult {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  duration: number;
  requestable: boolean;
  reason?: "recently_played" | "already_requested";
}

export type RequestStatus = "pending" | "queued" | "played" | "rejected";

export interface RequestItem {
  id: string;
  title: string;
  artist: string;
  coverUrl: string | null;
  name: string | null;
  message: string | null;
  status: RequestStatus;
  createdAt: number;
  ipHash?: string;
}

export interface QueueItem {
  rid: string;
  id: string;
  type: "song" | "interludio";
  artist?: string;
  title?: string;
  script?: string;
  pending?: boolean;
}

export interface StudioOverview {
  now: NowPayload;
  queue: QueueItem[];
  requestsPending: number;
  listeners24h: Array<{ t: number; n: number }>;
  engine: { ok: boolean; uptimeSeconds: number; rssMb: number | null; live: boolean };
  live: { srtUrl: string; streamKeyConfigured: boolean };
}
