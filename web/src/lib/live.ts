// Estado en vivo de la estación: SSE + fallback a polling, historial y programación.
// Los metadatos se muestran con el mismo retraso con el que el oyente escucha el audio,
// así el título cambia cuando de verdad cambia la canción en sus auriculares.
import { useEffect, useState } from "react";
import { player, setStreams } from "./player";
import { createStore, useStore } from "./store";
import type { HistoryItem, Listeners, NowPayload, RequestItem, SchedulePayload, SearchResult } from "./types";

interface Snapshot {
  at: number; // reloj del cliente
  data: NowPayload;
}

interface LiveState {
  connection: "connecting" | "open" | "offline";
  snapshots: Snapshot[];
  listeners: Listeners | null;
  history: HistoryItem[];
  schedule: SchedulePayload | null;
  requests: RequestItem[];
  /** Contadores de corazones recibidos por SSE (pisan a los de los payloads) */
  hearts: Record<string, number>;
  /** Pistas a las que este navegador ya les dio corazón */
  myHearts: Record<string, true>;
  /** serverTime - Date.now() */
  offset: number;
}

export const live = createStore<LiveState>({
  connection: "connecting",
  snapshots: [],
  listeners: null,
  history: [],
  schedule: null,
  requests: [],
  hearts: {},
  myHearts: {},
  offset: 0,
});

function readMyHearts(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem("bloom:hearts") || "{}");
  } catch {
    return {};
  }
}

let started = false;
let es: EventSource | null = null;
let pollTimer: number | undefined;
let historyTimer: number | undefined;

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j?.ok ? j.data : null) as T | null;
  } catch {
    return null;
  }
}

function pushNow(data: NowPayload) {
  const at = Date.now();
  setStreams(data.stream);
  live.set((s) => {
    const last = s.snapshots[s.snapshots.length - 1];
    const changed = !last || last.data.track?.key !== data.track?.key;
    // Guardamos ~2 min de snapshots para poder "retrasar" lo que se muestra
    const snapshots = [...s.snapshots, { at, data }].filter((x, i, arr) => i === arr.length - 1 || at - x.at < 120_000);
    if (changed) scheduleHistoryRefresh();
    return {
      snapshots,
      listeners: data.listeners,
      offset: data.serverTime ? data.serverTime - at : s.offset,
    };
  });
}

function scheduleHistoryRefresh() {
  clearTimeout(historyTimer);
  historyTimer = window.setTimeout(loadHistory, 1500);
}

async function loadHistory() {
  const h = await getJSON<HistoryItem[]>("/api/live/history?limit=30");
  if (h) live.set({ history: h });
}

async function loadSchedule() {
  const s = await getJSON<SchedulePayload>("/api/live/schedule");
  if (s) live.set({ schedule: s });
}

async function loadRequests() {
  const r = await getJSON<RequestItem[]>("/api/live/requests");
  if (r) live.set({ requests: r });
}

async function poll() {
  const n = await getJSON<NowPayload>("/api/live/now");
  if (n) {
    pushNow(n);
    live.set({ connection: "open" });
  } else {
    live.set({ connection: "offline" });
  }
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function startPolling() {
  stopPolling();
  void poll();
  pollTimer = window.setInterval(poll, 8000);
}

function connect() {
  if (typeof EventSource === "undefined") return startPolling();
  es?.close();
  es = new EventSource("/api/live/events");
  es.addEventListener("now", (e) => {
    try {
      pushNow(JSON.parse((e as MessageEvent).data));
      live.set({ connection: "open" });
      stopPolling();
    } catch {
      /* evento malformado */
    }
  });
  es.addEventListener("listeners", (e) => {
    try {
      live.set({ listeners: JSON.parse((e as MessageEvent).data) });
    } catch {
      /* evento malformado */
    }
  });
  es.addEventListener("requests", (e) => {
    try {
      live.set({ requests: JSON.parse((e as MessageEvent).data) });
    } catch {
      /* evento malformado */
    }
  });
  es.addEventListener("hearts", (e) => {
    try {
      const { key, count } = JSON.parse((e as MessageEvent).data) as { key: string; count: number };
      live.set((s) => ({ hearts: { ...s.hearts, [key]: count } }));
    } catch {
      /* evento malformado */
    }
  });
  es.onerror = () => {
    // EventSource reintenta solo; mientras tanto mantenemos datos frescos por polling
    live.set({ connection: es?.readyState === EventSource.CLOSED ? "offline" : "connecting" });
    if (!pollTimer) startPolling();
  };
}

export function startLive() {
  if (started || typeof window === "undefined") return;
  started = true;
  // Se lee tras hidratar (no en el estado inicial) para no desajustar el HTML estático
  live.set({ myHearts: readMyHearts() });
  void poll();
  connect();
  void loadHistory();
  void loadSchedule();
  void loadRequests();
  window.setInterval(loadSchedule, 10 * 60_000);
  window.setInterval(loadRequests, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && es?.readyState === EventSource.CLOSED) connect();
  });
}

/** Snapshot que corresponde a lo que el oyente está oyendo ahora mismo */
export function pickSnapshot(snapshots: Snapshot[], lagMs: number, now = Date.now()): NowPayload | null {
  if (snapshots.length === 0) return null;
  const target = now - lagMs;
  let chosen = snapshots[0];
  for (const s of snapshots) if (s.at <= target) chosen = s;
  return chosen.data;
}

/** Hook principal: datos en vivo alineados con el audio */
export function useNow() {
  const s = useStore(live);
  const { lagMs, status } = useStore(player);
  const lag = status === "playing" ? lagMs : 0;
  const [, tick] = useState(0);

  useEffect(() => {
    startLive();
  }, []);

  // Re-evaluar el snapshot visible cuando el retraso "alcanza" a un cambio
  useEffect(() => {
    if (lag === 0 || s.snapshots.length < 2) return;
    const id = window.setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [lag, s.snapshots.length]);

  const now = pickSnapshot(s.snapshots, lag);
  return {
    now,
    lag,
    listeners: s.listeners,
    connection: s.connection,
    offset: s.offset,
    history: s.history,
    schedule: s.schedule,
    requests: s.requests,
    hearts: s.hearts,
    myHearts: s.myHearts,
  };
}

export function useSchedule() {
  const s = useStore(live);
  useEffect(() => {
    startLive();
  }, []);
  return { schedule: s.schedule, offset: s.offset };
}

// ───────── Interacción del oyente ─────────

export function heartCount(key: string | undefined, fromPayload: number | undefined): number {
  if (!key) return fromPayload ?? 0;
  return live.get().hearts[key] ?? fromPayload ?? 0;
}

export async function sendHeart(key: string, current: number) {
  const s = live.get();
  if (s.myHearts[key]) return;
  const myHearts = { ...s.myHearts, [key]: true as const };
  // Optimista: el corazón se marca al instante
  live.set({ myHearts, hearts: { ...s.hearts, [key]: current + 1 } });
  try {
    localStorage.setItem("bloom:hearts", JSON.stringify(myHearts));
  } catch {
    /* almacenamiento no disponible */
  }
  try {
    const r = await fetch("/api/live/hearts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const j = await r.json();
    if (j?.ok) live.set((st) => ({ hearts: { ...st.hearts, [key]: j.data.count } }));
  } catch {
    /* sin red: se queda el optimista */
  }
}

export async function searchLibrary(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  try {
    const r = await fetch(`/api/live/search?q=${encodeURIComponent(q)}&limit=12`, { signal });
    const j = await r.json();
    return j?.ok ? j.data : [];
  } catch {
    return [];
  }
}

export type RequestError = "rate_limited" | "recently_played" | "already_requested" | "queue_full" | "not_found" | "invalid" | "network";

export async function submitRequest(body: { trackId: string; name?: string; message?: string }): Promise<{ ok: true } | { ok: false; error: RequestError; retryAfter?: number }> {
  try {
    const r = await fetch("/api/live/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (j?.ok) {
      void loadRequests();
      return { ok: true };
    }
    return { ok: false, error: (j?.error as RequestError) ?? "network", retryAfter: j?.retryAfter };
  } catch {
    return { ok: false, error: "network" };
  }
}
