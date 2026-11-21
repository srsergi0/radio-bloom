// Motor de audio: un único <audio> para toda la página, reconexión automática,
// medición del retraso (lo que suena vs. el directo) y analizador para el visualizador.
import { createStore } from "./store";

export type PlayerStatus = "idle" | "loading" | "playing" | "reconnecting" | "error";

interface PlayerState {
  status: PlayerStatus;
  volume: number;
  muted: boolean;
  /** Retraso estimado entre el directo y lo que el oyente escucha (ms) */
  lagMs: number;
  codec: "opus" | "mp3";
  hasAnalyser: boolean;
}

const DEFAULT_STREAMS = { opus: "/radiobloom.opus", mp3: "/radiobloom.mp3" };
const VOLUME_KEY = "bloom:volume";

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.85;
  } catch {
    return 0.85;
  }
}

export const player = createStore<PlayerState>({
  status: "idle",
  volume: 0.85,
  muted: false,
  lagMs: 0,
  codec: "opus",
  hasAnalyser: false,
});

let audio: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let streams = { ...DEFAULT_STREAMS };
let triedFallback = false;
let retries = 0;
let retryTimer: number | undefined;
let stallTimer: number | undefined;
let lagTimer: number | undefined;
let wanted = false;

const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export function setStreams(s: { opus?: string; mp3?: string }) {
  streams = { opus: s.opus || DEFAULT_STREAMS.opus, mp3: s.mp3 || DEFAULT_STREAMS.mp3 };
}

export function getAnalyser(): AnalyserNode | null {
  return analyser;
}

function pickCodec(): "opus" | "mp3" {
  if (triedFallback) return "mp3";
  const a = audio ?? document.createElement("audio");
  return a.canPlayType('audio/ogg; codecs="opus"') ? "opus" : "mp3";
}

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "none";
  audio.crossOrigin = "anonymous";
  const vol = readVolume();
  audio.volume = vol;
  player.set({ volume: vol });

  audio.addEventListener("playing", () => {
    retries = 0;
    clearTimeout(stallTimer);
    player.set({ status: "playing" });
  });
  audio.addEventListener("waiting", () => {
    if (!wanted) return;
    clearTimeout(stallTimer);
    // Si el buffer no se recupera en 10s, reconectamos en limpio
    stallTimer = window.setTimeout(() => reconnect(), 10_000);
  });
  audio.addEventListener("error", () => {
    if (!wanted) return;
    if (!triedFallback && player.get().codec === "opus") {
      triedFallback = true;
      start();
      return;
    }
    reconnect();
  });
  audio.addEventListener("ended", () => wanted && reconnect());
  return audio;
}

function setupAnalyser() {
  if (analyser || !audio || isIOS()) return;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    const src = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.82;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    player.set({ hasAnalyser: true });
  } catch {
    analyser = null;
  }
}

function measureLag() {
  clearInterval(lagTimer);
  lagTimer = window.setInterval(() => {
    if (!audio || audio.paused || audio.buffered.length === 0) return;
    const ahead = audio.buffered.end(audio.buffered.length - 1) - audio.currentTime;
    if (!Number.isFinite(ahead) || ahead < 0) return;
    const next = Math.min(ahead * 1000, 90_000);
    const prev = player.get().lagMs;
    // Media móvil para que la UI no salte
    const smoothed = prev === 0 ? next : prev * 0.8 + next * 0.2;
    if (Math.abs(smoothed - prev) > 150) player.set({ lagMs: smoothed });
  }, 1000);
}

function start() {
  const a = ensureAudio();
  const codec = pickCodec();
  player.set({ codec, status: retries > 0 ? "reconnecting" : "loading" });
  a.src = `${streams[codec]}?t=${Date.now()}`;
  a.load();
  setupAnalyser();
  if (ctx?.state === "suspended") void ctx.resume();
  a.play().catch((err: Error) => {
    if (err.name === "NotAllowedError") {
      wanted = false;
      player.set({ status: "idle" });
    }
  });
  measureLag();
}

function reconnect() {
  if (!wanted) return;
  clearTimeout(retryTimer);
  retries++;
  if (retries > 8) {
    wanted = false;
    player.set({ status: "error" });
    return;
  }
  player.set({ status: "reconnecting" });
  const wait = Math.min(1000 * 2 ** (retries - 1), 15_000);
  retryTimer = window.setTimeout(start, wait);
}

export function play() {
  wanted = true;
  retries = 0;
  start();
}

/** En un directo, "pausa" = cortar: al volver se reengancha al presente */
export function stop() {
  wanted = false;
  clearTimeout(retryTimer);
  clearTimeout(stallTimer);
  clearInterval(lagTimer);
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  player.set({ status: "idle", lagMs: 0 });
}

export function toggle() {
  const s = player.get().status;
  if (s === "idle" || s === "error") play();
  else stop();
}

export function setVolume(v: number) {
  const vol = Math.max(0, Math.min(1, v));
  ensureAudio().volume = vol;
  ensureAudio().muted = vol === 0;
  player.set({ volume: vol, muted: vol === 0 });
  try {
    localStorage.setItem(VOLUME_KEY, String(vol));
  } catch {
    /* almacenamiento no disponible */
  }
}

export function toggleMute() {
  const a = ensureAudio();
  a.muted = !a.muted;
  player.set({ muted: a.muted });
}

export function isActive(s: PlayerStatus) {
  return s === "playing" || s === "loading" || s === "reconnecting";
}

// Controles del sistema (pantalla de bloqueo, auriculares, teclado multimedia)
if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", play);
  navigator.mediaSession.setActionHandler("pause", stop);
  navigator.mediaSession.setActionHandler("stop", stop);
}
