// Parrilla semanal: una línea de 24 h por día con cada franja y su locutor
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { describeVoice, hmToMin, hueOf, limaNow, minToHM } from "../lib/format";
import { type Lang, t } from "../lib/i18n";
import { useSchedule } from "../lib/live";
import type { ScheduleSlot } from "../lib/types";

export default function Schedule({ lang }: { lang: Lang }) {
  const s = t(lang);
  const { schedule, offset } = useSchedule();
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const lima = limaNow(clockNow + offset);
  const [day, setDay] = useState<number | null>(null);
  const shownDay = day ?? lima.dayOfWeek;
  const isToday = shownDay === lima.dayOfWeek;

  const slots = useMemo(
    () =>
      (schedule?.slots ?? [])
        .filter((x) => x.dayOfWeek === shownDay)
        .sort((a, b) => hmToMin(a.start) - hmToMin(b.start)),
    [schedule, shownDay],
  );

  const isOn = (x: ScheduleSlot) => {
    if (!isToday) return false;
    const start = hmToMin(x.start);
    return lima.minute >= start && lima.minute < start + x.duration;
  };
  const current = slots.find(isOn);
  const [picked, setPicked] = useState<number | null>(null);
  const focus = slots.find((x) => x.locutorId === picked && x.dayOfWeek === shownDay) ?? current ?? slots[0];

  // Orden de días empezando por hoy
  const order = Array.from({ length: 7 }, (_, i) => (lima.dayOfWeek + i) % 7);

  return (
    <section className="schedule" id="programacion" aria-labelledby="h-schedule">
      <header className="section-head">
        <p className="eyebrow">{s.limaTime}</p>
        <h2 id="h-schedule" className="display">
          {s.schedule}
        </h2>
        <p className="section-head__sub">{s.scheduleSub}</p>
      </header>

      <div className="days" role="tablist" aria-label={s.schedule}>
        {order.map((d, i) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === shownDay}
            className={`days__tab ${d === shownDay ? "is-on" : ""}`}
            onClick={() => {
              setDay(d);
              setPicked(null);
            }}
          >
            <span className="days__short">{i === 0 ? s.today : s.daysShort[d]}</span>
            <span className="days__long">{i === 0 ? s.today : s.days[d]}</span>
          </button>
        ))}
      </div>

      {slots.length === 0 ? (
        <p className="panel__empty schedule__empty">{s.scheduleEmpty}</p>
      ) : (
        <>
          <div className="timeline" role="tabpanel">
            <div className="timeline__track">
              {slots.map((x) => {
                const start = hmToMin(x.start);
                const left = (start / 1440) * 100;
                const width = (Math.min(x.duration, 1440 - start) / 1440) * 100;
                const on = isOn(x);
                return (
                  <button
                    key={`${x.locutorId}-${x.start}`}
                    type="button"
                    className={`slot ${on ? "is-on" : ""} ${focus === x ? "is-focus" : ""}`}
                    style={{ left: `${left}%`, width: `${width}%`, "--slot-hue": hueOf(x.hostName) } as CSSProperties}
                    onClick={() => setPicked(x.locutorId)}
                    title={`${x.start} · ${x.hostName}`}
                  >
                    <span className="slot__time">{x.start}</span>
                    <span className="slot__name">{x.hostName}</span>
                  </button>
                );
              })}
              {isToday && (
                <span className="timeline__now" style={{ left: `${(lima.minute / 1440) * 100}%` }}>
                  <span>{s.nowMarker}</span>
                </span>
              )}
            </div>
            <div className="timeline__ticks" aria-hidden="true">
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
                <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
                  {String(h % 24).padStart(2, "0")}
                </span>
              ))}
            </div>
          </div>

          <ul className="lineup">
            {slots.map((x) => {
              const v = describeVoice(x.voice, lang);
              const start = hmToMin(x.start);
              return (
                <li key={`${x.locutorId}-${x.start}-l`}>
                  <button
                    type="button"
                    className={`host ${isOn(x) ? "is-on" : ""} ${focus === x ? "is-focus" : ""}`}
                    onClick={() => setPicked(x.locutorId)}
                    style={{ "--slot-hue": hueOf(x.hostName) } as CSSProperties}
                  >
                    <span className="host__time">
                      {x.start}–{minToHM(start + x.duration)}
                    </span>
                    <span className="host__avatar" aria-hidden="true">
                      {x.hostName.slice(0, 1)}
                    </span>
                    <span className="host__body">
                      <span className="host__name">
                        {x.hostName}
                        {isOn(x) && <span className="host__live">{s.onAir}</span>}
                      </span>
                      <span className="host__voice">
                        {s.voice} {v.name} · {v.region}
                      </span>
                      {focus === x && x.personality && <span className="host__bio">{x.personality}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
