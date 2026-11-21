// Barra fija inferior cuando el escenario sale de la vista + botón de la cabecera
import { useEffect, useState } from "react";
import { type Lang, t } from "../lib/i18n";
import { useNow } from "../lib/live";
import { isActive, player, toggle } from "../lib/player";
import { useStore } from "../lib/store";
import Cover from "./Cover";
import { PlayIcon, Spinner, StopIcon, WaveIcon } from "./Icons";

export default function MiniPlayer({ lang }: { lang: Lang }) {
  const s = t(lang);
  const { now, listeners } = useNow();
  const p = useStore(player);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const stage = document.getElementById("ahora");
    if (!stage) return;
    const io = new IntersectionObserver(([e]) => setShow(!e.isIntersecting), { threshold: 0.05 });
    io.observe(stage);
    return () => io.disconnect();
  }, []);

  const track = now?.track;
  const interlude = track?.type === "interludio";
  const title = !track ? "Radio Tceos" : interlude ? s.interlude : track.title;
  const artist = !track ? "" : interlude ? (now?.host?.name ?? "") : track.artist;
  const active = isActive(p.status);
  const busy = p.status === "loading" || p.status === "reconnecting";

  return (
    <div className={`mini ${show ? "is-shown" : ""}`} aria-hidden={!show}>
      <a href="#ahora" className="mini__info" tabIndex={show ? 0 : -1}>
        <Cover src={track?.coverUrl} seed={track?.key ?? "bloom"} label={title} className="mini__cover" />
        <span className="mini__text">
          <span className="mini__title">{title}</span>
          <span className="mini__artist">
            {active && <WaveIcon size={12} />} {artist}
            {listeners && listeners.current > 0 && <span className="mini__count"> · {listeners.current} ♫</span>}
          </span>
        </span>
      </a>
      <button type="button" className={`mini__play ${active ? "is-active" : ""}`} onClick={toggle} aria-label={active ? s.stop : s.listen} tabIndex={show ? 0 : -1}>
        {busy ? <Spinner size={20} /> : active ? <StopIcon size={20} /> : <PlayIcon size={22} />}
      </button>
    </div>
  );
}

export function HeaderListen({ lang }: { lang: Lang }) {
  const s = t(lang);
  const p = useStore(player);
  const { now } = useNow();
  const active = isActive(p.status);
  return (
    <button type="button" className={`hdr-listen ${active ? "is-active" : ""}`} onClick={toggle}>
      <span className={`onair__dot ${now?.onAir.isLive ? "is-live" : ""}`} />
      {active ? s.stop : s.listen}
    </button>
  );
}
