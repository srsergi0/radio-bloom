// Pedidos de oyentes: buscar en la biblioteca, dedicar y ver el muro en vivo
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { clock } from "../lib/format";
import { type Lang, t } from "../lib/i18n";
import { type RequestError, searchLibrary, submitRequest, useNow } from "../lib/live";
import type { SearchResult } from "../lib/types";
import Cover from "./Cover";

const ease = [0.22, 1, 0.36, 1] as const;

export default function Requests({ lang }: { lang: Lang }) {
  const s = t(lang);
  const { requests } = useNow();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<SearchResult | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const [sent, setSent] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Búsqueda con debounce y cancelación de la petición anterior
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    const id = window.setTimeout(async () => {
      const r = await searchLibrary(term, ctl.signal);
      if (!ctl.signal.aborted) {
        setResults(r);
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
  }, [q]);

  useEffect(() => {
    if (picked) nameRef.current?.focus();
  }, [picked]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!picked || sending) return;
    setSending(true);
    setError(null);
    const r = await submitRequest({
      trackId: picked.id,
      name: name.trim() || undefined,
      message: message.trim() || undefined,
    });
    setSending(false);
    if (r.ok) {
      setSent(true);
      setPicked(null);
      setMessage("");
      setQ("");
      setResults(null);
      window.setTimeout(() => setSent(false), 6000);
    } else {
      setError(r.error);
    }
  }

  const wall = requests.filter((r) => r.status !== "rejected").slice(0, 12);

  return (
    <section className="requests" id="pedidos" aria-labelledby="h-requests">
      <header className="section-head">
        <p className="eyebrow">{lang === "es" ? "Tu turno" : "Your turn"}</p>
        <h2 id="h-requests" className="display">
          {s.requests}
        </h2>
        <p className="section-head__sub">{s.requestsSub}</p>
      </header>

      <div className="requests__grid">
        <div className="panel requests__finder">
          {picked ? (
            <form className="reqform" onSubmit={send}>
              <div className="reqform__track">
                <Cover src={picked.coverUrl} seed={picked.id} label={picked.title} className="track__cover" />
                <span className="track__text">
                  <span className="track__title">{picked.title}</span>
                  <span className="track__artist">{picked.artist}</span>
                </span>
              </div>
              <label className="field">
                <span>{s.yourName}</span>
                <input ref={nameRef} value={name} maxLength={32} onChange={(e) => setName(e.target.value)} autoComplete="given-name" />
              </label>
              <label className="field">
                <span>{s.yourMessage}</span>
                <textarea value={message} maxLength={140} rows={3} onChange={(e) => setMessage(e.target.value)} />
                <small className="field__count">{message.length}/140</small>
              </label>
              {error && <p className="reqform__error" role="alert">{s.reqErrors[error]}</p>}
              <div className="reqform__actions">
                <button type="submit" className="btn" disabled={sending}>
                  {sending ? "…" : s.send}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setPicked(null);
                    setError(null);
                  }}
                >
                  {s.cancel}
                </button>
              </div>
            </form>
          ) : (
            <>
              <label className="search">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={s.searchPlaceholder}
                  aria-label={s.searchPlaceholder}
                  enterKeyHint="search"
                />
              </label>
              {sent && (
                <p className="reqform__ok" role="status">
                  {s.sent}
                </p>
              )}
              {results === null ? (
                <p className="panel__empty">{q.trim().length > 0 ? s.searchHint : ""}</p>
              ) : results.length === 0 && !loading ? (
                <p className="panel__empty">{s.noResults}</p>
              ) : (
                <ul className="tracks results" aria-busy={loading}>
                  {results.map((r) => (
                    <li key={r.id} className="track">
                      <Cover src={r.coverUrl} seed={r.id} label={r.title} className="track__cover" />
                      <span className="track__text">
                        <span className="track__title">{r.title}</span>
                        <span className="track__artist">
                          {r.artist}
                          {r.duration > 0 && <span className="track__dur"> · {clock(r.duration)}</span>}
                        </span>
                      </span>
                      {r.requestable ? (
                        <button type="button" className="btn btn--sm" onClick={() => setPicked(r)}>
                          {s.request}
                        </button>
                      ) : (
                        <span className="results__na">{r.reason ? s.unavailable[r.reason] : "—"}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="panel requests__wall">
          <header className="panel__head">
            <h3>{s.requestWall}</h3>
          </header>
          {wall.length === 0 ? (
            <p className="panel__empty">{s.requestWallEmpty}</p>
          ) : (
            <ul className="wall">
              <AnimatePresence initial={false}>
                {wall.map((r) => (
                  <motion.li
                    key={r.id}
                    layout
                    className={`wall__item is-${r.status}`}
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.45, ease }}
                  >
                    <div className="wall__head">
                      <span className="wall__who">{r.name ?? (lang === "es" ? "Alguien" : "Someone")}</span>
                      <span className={`wall__status is-${r.status}`}>{s.status[r.status]}</span>
                    </div>
                    {r.message && <p className="wall__msg">“{r.message}”</p>}
                    <p className="wall__track">
                      ♪ {r.title} — {r.artist}
                    </p>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
