// Reproductor compacto para incrustar en otras webs (<iframe src="/embed">)
import { useEffect, useState } from "react";
import { accentFromImage, fallbackAccent } from "../lib/color";
import { useNow } from "../lib/live";
import { isActive, player, toggle } from "../lib/player";
import { useStore } from "../lib/store";
import Cover from "./Cover";
import { PlayIcon, Spinner, StopIcon, WaveIcon } from "./Icons";

export default function Embed() {
  const { now, listeners } = useNow();
  const p = useStore(player);
  const track = now?.track;
  const interlude = track?.type === "interludio";
  const title = !track ? "Bloom Radio" : interlude ? "Locución" : track.title;
  const artist = !track ? "Lima · 24/7" : interlude ? (now?.host?.name ?? "") : track.artist;
  const active = isActive(p.status);
  const busy = p.status === "loading" || p.status === "reconnecting";
  const [, setTick] = useState(0);

  useEffect(() => {
    const key = track?.key ?? "";
    const apply = (c: string) => {
      document.documentElement.style.setProperty("--accent", c);
      setTick((n) => n + 1);
    };
    if (track?.coverUrl) accentFromImage(track.coverUrl).then((c) => apply(c ?? fallbackAccent(key)));
    else if (key) apply(fallbackAccent(key));
  }, [track?.key, track?.coverUrl]);

  return (
    <div className="embed">
      <Cover src={track?.coverUrl} seed={track?.key ?? "bloom"} label={title} className="embed__cover" />
      <div className="embed__text">
        <a className="embed__brand" href="/" target="_blank" rel="noreferrer">
          <span className={`onair__dot ${now?.onAir.isLive ? "is-live" : ""}`} /> bloom<em>radio</em>
          {listeners && listeners.current > 0 && <span className="embed__count"> · {listeners.current} escuchando</span>}
        </a>
        <span className="embed__title">{title}</span>
        <span className="embed__artist">
          {active && <WaveIcon size={12} />} {artist}
        </span>
      </div>
      <button type="button" className={`mini__play ${active ? "is-active" : ""}`} onClick={toggle} aria-label={active ? "Detener" : "Escuchar"}>
        {busy ? <Spinner size={20} /> : active ? <StopIcon size={20} /> : <PlayIcon size={22} />}
      </button>
    </div>
  );
}
