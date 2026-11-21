// Escenario principal: la flor, la portada, lo que suena, quién está en cabina y el botón.
import { type CSSProperties, useEffect, useState } from "react";
import { accentFromImage, DEFAULT_ACCENT, fallbackAccent } from "../lib/color";
import { clock, describeVoice, limaHM } from "../lib/format";
import { type Lang, t } from "../lib/i18n";
import { useNow } from "../lib/live";
import { isActive, player, setVolume, toggle, toggleMute } from "../lib/player";
import { useStore } from "../lib/store";
import type { LiveTrack } from "../lib/types";
import BloomVisualizer from "./BloomVisualizer";
import Cover from "./Cover";
import { PlayIcon, Spinner, StopIcon, VolumeIcon } from "./Icons";

export default function Station({ lang }: { lang: Lang }) {
  const s = t(lang);
  const { now, lag, listeners, connection, offset } = useNow();
  const p = useStore(player);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const track = now?.track ?? null;
  const host = now?.host ?? null;
  const active = isActive(p.status);
  const isInterlude = track?.type === "interludio";

  // Color de la escena según la portada
  useEffect(() => {
    let cancelled = false;
    const key = track?.key ?? "";
    const apply = (c: string) => {
      if (cancelled) return;
      setAccent(c);
      document.documentElement.style.setProperty("--accent", c);
    };
    if (track?.coverUrl) {
      accentFromImage(track.coverUrl).then((c) => apply(c ?? fallbackAccent(key)));
    } else if (key) {
      apply(fallbackAccent(key));
    }
    return () => {
      cancelled = true;
    };
  }, [track?.key, track?.coverUrl]);

  // Título de la pestaña + controles del sistema operativo
  useEffect(() => {
    if (!track) return;
    const title = isInterlude ? s.interlude : track.title;
    const artist = isInterlude ? (host?.name ?? "Bloom Radio") : track.artist;
    document.title = `${active ? "▶ " : ""}${title} — ${artist} · Bloom Radio`;
    if ("mediaSession" in navigator) {
      const art = track.coverUrl ? new URL(track.coverUrl, location.href).href : new URL("/icons/icon-512.png", location.href).href;
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album: track.album ?? "Bloom Radio · Lima",
        artwork: [{ src: art, sizes: "512x512" }],
      });
    }
  }, [track?.key, isInterlude, host?.name, active, s.interlude]);

  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = active ? "playing" : "paused";
  }, [active]);

  // Atajo: barra espaciadora
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.code !== "Space" || e.repeat || el.closest("input, textarea, select, button, a, [contenteditable]")) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const title = !track ? "Bloom Radio" : isInterlude ? s.interlude : track.title;
  const artist = !track ? "" : isInterlude ? (host?.name ?? "") : track.artist;
  const next = now?.upNext?.find((u) => u.type === "song");
  const isLive = now?.onAir.isLive ?? false;
  const v = host ? describeVoice(host.voice, lang) : null;

  return (
    <section className="stage" id="ahora" aria-label={s.nowPlaying}>
      <div className="stage__art">
        <BloomVisualizer accent={accent} active={active} />
        <div className={`stage__disc ${active ? "is-spinning" : ""}`}>
          <Cover src={track?.coverUrl} seed={track?.key ?? "bloom"} label={title} round />
        </div>
      </div>

      <div className="stage__meta">
        <div className="onair">
          <span className={`onair__pill ${isLive ? "is-live" : ""}`}>
            <span className="onair__dot" />
            {isLive ? s.live : s.onAir}
          </span>
          {listeners && listeners.current > 0 && <span className="onair__count">{s.listeners(listeners.current)}</span>}
          {connection === "offline" && <span className="onair__warn">{s.offline}</span>}
        </div>

        <p className="eyebrow">{s.nowPlaying}</p>
        <h1 className={`np__title ${title.length > 42 ? "is-long" : ""}`} key={track?.key}>
          {title}
        </h1>
        <p className="np__artist">
          {artist}
          {track?.album && !isInterlude && <span className="np__album"> · {track.album}</span>}
        </p>

        {track && track.duration > 0 && <Progress track={track} offset={offset} lag={lag} />}

        <div className="controls">
          <button
            type="button"
            className={`play ${active ? "is-active" : ""}`}
            onClick={toggle}
            aria-label={active ? s.stop : s.listen}
            title={s.shortcut}
          >
            <span className="play__icon">
              {p.status === "loading" || p.status === "reconnecting" ? <Spinner size={26} /> : active ? <StopIcon size={26} /> : <PlayIcon size={28} />}
            </span>
            <span className="play__label">
              {p.status === "loading" ? s.connecting : p.status === "reconnecting" ? s.reconnecting : active ? s.stop : s.listen}
            </span>
          </button>

          <div className="volume">
            <button type="button" className="icon-btn" onClick={toggleMute} aria-label={p.muted ? s.unmute : s.mute}>
              <VolumeIcon muted={p.muted || p.volume === 0} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={p.muted ? 0 : p.volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label={s.volume}
              style={{ "--fill": `${(p.muted ? 0 : p.volume) * 100}%` } as CSSProperties}
            />
          </div>
        </div>
        {p.status === "error" && <p className="np__error">{s.streamError}</p>}
        {lag > 3000 && p.status === "playing" && <p className="np__sync">{s.syncedHint(Math.round(lag / 1000))}</p>}

        <div className="booth">
          <div className="booth__avatar" aria-hidden="true">
            <span>{host ? host.name.slice(0, 1) : "✿"}</span>
          </div>
          <div className="booth__body">
            <p className="eyebrow">{s.inBooth}</p>
            <p className="booth__name">{host ? host.name : s.noHost}</p>
            <p className="booth__sub">
              {host ? (
                <>
                  {v && (
                    <span title={host.voice}>
                      {s.voice} {v.name} · {v.region}
                    </span>
                  )}
                  {host.show && <span> · {s.until(limaHM(host.show.endsAt))}</span>}
                </>
              ) : (
                s.noHostSub
              )}
            </p>
          </div>
        </div>

        {next && (
          <p className="nextchip">
            <span className="eyebrow">{s.upNext}</span>
            <span className="nextchip__text">
              {next.title} — {next.artist}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}

function Progress({ track, offset, lag }: { track: LiveTrack; offset: number; lag: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.min(track.duration, (now + offset - lag - track.startedAt) / 1000));
  const pct = (elapsed / track.duration) * 100;
  return (
    <div className="progress">
      <div className="progress__bar" role="progressbar" aria-valuemin={0} aria-valuemax={Math.round(track.duration)} aria-valuenow={Math.round(elapsed)}>
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress__times">
        <span>{clock(elapsed)}</span>
        <span>−{clock(track.duration - elapsed)}</span>
      </div>
    </div>
  );
}
