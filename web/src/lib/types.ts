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
