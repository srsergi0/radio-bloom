// Lo que viene + lo que sonó, alineado con lo que el oyente realmente escucha
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { clock, limaHM } from "../lib/format";
import { type Lang, t } from "../lib/i18n";
import { useNow } from "../lib/live";
import Cover from "./Cover";
import Heart from "./Heart";

const ease = [0.22, 1, 0.36, 1] as const;

export default function Feed({ lang }: { lang: Lang }) {
  const s = t(lang);
  const { now, history, offset, lag } = useNow();
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const current = now?.track;
  // El historial del servidor va por delante del audio del oyente: ocultamos lo que aún no ha oído
  const heardUntil = current ? current.startedAt - 1500 : clockNow + offset - lag;
  const past = history.filter((h) => h.playedAt < heardUntil).slice(0, 12);
  const upNext = (now?.upNext ?? []).filter((u) => u.type === "song").slice(0, 5);

  return (
    <div className="feed">
      <section className="panel" id="lo-que-viene" aria-labelledby="h-upnext">
        <header className="panel__head">
          <h2 id="h-upnext">{s.upNext}</h2>
        </header>
        {upNext.length === 0 ? (
          <p className="panel__empty">{s.upNextEmpty}</p>
        ) : (
          <ol className="tracks">
            <AnimatePresence initial={false}>
              {upNext.map((u, i) => (
                <motion.li
                  key={`${u.title}-${u.artist}-${i}`}
                  className="track"
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  transition={{ duration: 0.45, ease }}
                >
                  <span className="track__index">{String(i + 1).padStart(2, "0")}</span>
                  <Cover src={u.coverUrl} seed={`${u.title}${u.artist}`} label={u.title} className="track__cover" />
                  <span className="track__text">
                    <span className="track__title">{u.title}</span>
                    <span className="track__artist">{u.artist}</span>
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
      </section>

      <section className="panel" id="historial" aria-labelledby="h-history">
        <header className="panel__head">
          <h2 id="h-history">{s.history}</h2>
        </header>
        {past.length === 0 ? (
          <p className="panel__empty">{s.historyEmpty}</p>
        ) : (
          <ol className="tracks">
            <AnimatePresence initial={false}>
              {past.map((h) => {
                const mins = Math.floor((clockNow + offset - lag - h.playedAt) / 60_000);
                return (
                  <motion.li
                    key={`${h.playedAt}-${h.title}`}
                    className="track"
                    layout
                    initial={{ opacity: 0, y: -12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5, ease }}
                  >
                    <time className="track__time" dateTime={new Date(h.playedAt).toISOString()} title={s.ago(mins)}>
                      {limaHM(h.playedAt)}
                    </time>
                    <Cover src={h.coverUrl} seed={`${h.title}${h.artist}`} label={h.title} className="track__cover" />
                    <span className="track__text">
                      <span className="track__title">{h.title}</span>
                      <span className="track__artist">
                        {h.artist}
                        {h.duration > 0 && <span className="track__dur"> · {clock(h.duration)}</span>}
                      </span>
                    </span>
                    <Heart trackKey={h.key} count={h.hearts} label={s.heart} labelOn={s.hearted} size="sm" />
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ol>
        )}
      </section>
    </div>
  );
}
