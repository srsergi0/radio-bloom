/**
 * Icecast-compatible `/status-json.xsl` for radio directories (pure mapping, no I/O).
 */
import type { LiveNowPayload } from "../domain/types";

export const DEFAULT_PUBLIC_HOST = "185.139.1.222";

type HeaderGetter = { get(name: string): string | null };

export interface IcecastSource {
  audio_info: string;
  bitrate: number;
  genre: string;
  listener_peak: number;
  listeners: number;
  listenurl: string;
  server_description: string;
  server_name: string;
  server_type: string;
  stream_start_iso8601: string;
  title: string;
}

export interface IcecastStatus {
  icestats: {
    admin: string;
    host: string;
    location: string;
    server_id: string;
    source: IcecastSource;
  };
}

const HOST_RE = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

/** Public host + scheme of the request (x-forwarded-host / host; https if forwarded as https). */
export function publicOrigin(
  headers: HeaderGetter,
  https: boolean,
  fallbackHost = DEFAULT_PUBLIC_HOST
): { host: string; origin: string } {
  const raw = (headers.get("x-forwarded-host") || headers.get("host") || "").split(",")[0].trim();
  const host = HOST_RE.test(raw) ? raw : fallbackHost;
  return { host, origin: `${https ? "https" : "http"}://${host}` };
}

export function nowTitle(now: Pick<LiveNowPayload, "track" | "station">): string {
  const t = now.track;
  if (!t?.title) return now.station?.name || "Bloom Radio";
  return t.artist ? `${t.artist} - ${t.title}` : t.title;
}

export function buildIcecastStatus(input: {
  now: LiveNowPayload;
  host: string;
  origin: string;
  streamStartMs: number;
}): IcecastStatus {
  const bitrate = input.now.stream?.bitrateKbps || 192;
  return {
    icestats: {
      admin: "",
      host: input.host.replace(/:\d+$/, ""),
      location: "Lima, Perú",
      server_id: "Bloom Radio",
      source: {
        audio_info: `bitrate=${bitrate}`,
        bitrate,
        genre: "Various",
        listener_peak: input.now.listeners?.peakToday ?? 0,
        listeners: input.now.listeners?.current ?? 0,
        listenurl: `${input.origin}/radiobloom.opus`,
        server_description: "Radio por internet desde Lima, Perú — música 24/7 con locutores de IA",
        server_name: "Bloom Radio",
        server_type: "audio/ogg",
        stream_start_iso8601: new Date(input.streamStartMs).toISOString(),
        title: nowTitle(input.now),
      },
    },
  };
}
