// Studio: sala de control privada de Bloom Radio
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { clock, describeVoice, limaHM } from "../../lib/format";
import { searchLibrary } from "../../lib/live";
import { studio, Unauthorized } from "../../lib/studio";
import type { RequestItem, SearchResult, StudioOverview } from "../../lib/types";
import Cover from "../Cover";
import ListenersChart from "./ListenersChart";

function uptime(sec: number): string {
  if (sec >= 86400) return `${Math.floor(sec / 86400)} d`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)} h`;
  return `${Math.max(1, Math.floor(sec / 60))} min`;
}

type Auth = "checking" | "out" | "in";

export default function StudioApp() {
  const [auth, setAuth] = useState<Auth>("checking");

  useEffect(() => {
    studio
      .me()
      .then((m) => setAuth(m.authenticated ? "in" : "out"))
      .catch(() => setAuth("out"));
  }, []);

  if (auth === "checking") return <div className="studio-center">Cargando…</div>;
  if (auth === "out") return <Login onDone={() => setAuth("in")} />;
  return <Console onLogout={() => setAuth("out")} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await studio.login(token.trim());
      onDone();
    } catch (err) {
      setError(err instanceof Unauthorized ? "Token incorrecto." : "No se pudo iniciar sesión. Intenta en unos minutos.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="studio-center">
      <form className="studio-login panel" onSubmit={submit}>
        <p className="eyebrow">Bloom Radio</p>
        <h1 className="display">Studio</h1>
        <label className="field">
          <span>Token de acceso</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" autoFocus />
        </label>
        {error && <p className="reqform__error">{error}</p>}
        <button className="btn" type="submit" disabled={busy || token.length < 8}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}

function Console({ onLogout }: { onLogout: () => void }) {
  const [ov, setOv] = useState<StudioOverview | null>(null);
  const [reqs, setReqs] = useState<RequestItem[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 2600);
  };

  const refresh = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([studio.overview(), studio.requests()]);
      setOv(o);
      setReqs(r);
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) onLogout();
      else setError("Sin conexión con el publisher");
    }
  }, [onLogout]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      flash(ok);
      void refresh();
    } catch (err) {
      if (err instanceof Unauthorized) onLogout();
      else flash(`Error: ${(err as Error).message}`);
    }
  }

  const now = ov?.now;
  const track = now?.track;
  const pending = reqs.filter((r) => r.status === "pending");
  const host = now?.host;
  const v = host ? describeVoice(host.voice, "es") : null;

  return (
    <div className="studio">
      <header className="studio__bar">
        <span className="hdr__brand">
          ✿ <span>
            bloom<em>studio</em>
          </span>
        </span>
        <span className={`studio__status ${ov?.engine.ok ? "is-ok" : "is-bad"}`}>
          {ov ? (ov.engine.ok ? "Motor OK" : "Motor degradado") : "…"}
          {ov && ` · ${uptime(ov.engine.uptimeSeconds)}`}
          {ov?.engine.rssMb ? ` · ${ov.engine.rssMb} MB` : ""}
        </span>
        {error && <span className="onair__warn">{error}</span>}
        <span className="studio__spacer" />
        <a className="hdr__lang" href="/" target="_blank" rel="noreferrer">
          Ver web ↗
        </a>
        <button type="button" className="hdr__lang" onClick={() => act(studio.logout, "Sesión cerrada").then(onLogout)}>
          Salir
        </button>
      </header>

      <div className="studio__grid">
        {/* Al aire */}
        <section className="panel studio__onair">
          <div className="onair">
            <span className={`onair__pill ${now?.onAir.isLive ? "is-live" : ""}`}>
              <span className="onair__dot" />
              {now?.onAir.isLive ? "En directo (SRT)" : now?.onAir.source === "queue" ? "Cola" : "AutoDJ"}
            </span>
          </div>
          <div className="studio__np">
            <Cover src={track?.coverUrl} seed={track?.key ?? "x"} label={track?.title ?? "—"} className="studio__cover" />
            <div className="studio__nptext">
              <p className="eyebrow">Ahora suena</p>
              <h2 className="studio__title">{track?.title ?? "—"}</h2>
              <p className="track__artist">
                {track?.artist}
                {track?.album ? ` · ${track.album}` : ""}
              </p>
              {track && track.duration > 0 && (
                <p className="studio__meta">
                  {clock(track.duration)} · empezó {limaHM(track.startedAt)} · ♥ {track.hearts ?? 0}
                </p>
              )}
              {track?.request && (
                <p className="studio__meta">
                  Pedida por {track.request.name ?? "un oyente"}
                  {track.request.message ? ` — “${track.request.message}”` : ""}
                </p>
              )}
            </div>
          </div>
          <div className="studio__actions">
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                if (confirm("¿Saltar la canción que está sonando para todos los oyentes?")) void act(studio.skip, "Saltada");
              }}
            >
              Saltar canción
            </button>
          </div>
          <div className="studio__host">
            <p className="eyebrow">En cabina</p>
            <p>
              <strong>{host?.name ?? "AutoDJ"}</strong>
              {v && ` · ${v.name} (${v.region})`}
              {host?.show && ` · hasta ${limaHM(host.show.endsAt)}`}
            </p>
          </div>
        </section>

        {/* Audiencia */}
        <section className="panel studio__aud">
          <div className="stats">
            <div>
              <p className="eyebrow">Escuchando</p>
              <p className="stat">{now?.listeners.current ?? "—"}</p>
            </div>
            <div>
              <p className="eyebrow">Pico de hoy</p>
              <p className="stat">{now?.listeners.peakToday ?? "—"}</p>
            </div>
            <div>
              <p className="eyebrow">Pedidos</p>
              <p className="stat">{ov?.requestsPending ?? "—"}</p>
            </div>
          </div>
          <p className="eyebrow studio__label">Oyentes · últimas 24 h (hora de Lima)</p>
          <ListenersChart points={ov?.listeners24h ?? []} />
        </section>

        {/* Pedidos */}
        <section className="panel studio__reqs">
          <header className="panel__head">
            <h3>Pedidos pendientes</h3>
            <span className="eyebrow">{pending.length}</span>
          </header>
          {pending.length === 0 ? (
            <p className="panel__empty">Nada pendiente. Los pedidos de la web aparecen aquí.</p>
          ) : (
            <ul className="wall">
              {pending.map((r) => (
                <li key={r.id} className="wall__item">
                  <div className="wall__head">
                    <span className="wall__who">{r.name ?? "Anónimo"}</span>
                    <span className="wall__status">
                      {limaHM(r.createdAt)}
                      {r.ipHash ? ` · ${r.ipHash}` : ""}
                    </span>
                  </div>
                  {r.message && <p className="wall__msg">“{r.message}”</p>}
                  <p className="wall__track">
                    ♪ {r.title} — {r.artist}
                  </p>
                  <div className="reqform__actions">
                    <button type="button" className="btn btn--sm" onClick={() => act(() => studio.approve(r.id), "Pedido a la cola")}>
                      Aprobar
                    </button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => act(() => studio.reject(r.id), "Pedido rechazado")}>
                      Rechazar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Cola */}
        <section className="panel studio__queue">
          <header className="panel__head">
            <h3>Cola</h3>
            <span className="eyebrow">{ov?.queue.length ?? 0} en cola</span>
          </header>
          {ov && ov.queue.length === 0 ? (
            <p className="panel__empty">Vacía: suena el AutoDJ. Añade canciones abajo.</p>
          ) : (
            <ol className="tracks">
              {ov?.queue.map((q, i) => (
                <li key={q.rid} className="track studio__qitem">
                  <span className="track__index">{String(i + 1).padStart(2, "0")}</span>
                  <span className="track__text">
                    <span className="track__title">{q.type === "interludio" ? "Locución" : (q.title ?? q.id)}</span>
                    <span className="track__artist">{q.type === "interludio" ? (q.script?.slice(0, 80) ?? "") : q.artist}</span>
                  </span>
                  {q.pending ? (
                    <span className="results__na">Procesando…</span>
                  ) : (
                    <button type="button" className="icon-btn" aria-label="Quitar de la cola" onClick={() => act(() => studio.removeFromQueue(q.rid), "Quitada de la cola")}>
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          <AddToQueue onAdd={(id) => act(() => studio.enqueue(id), "Añadida a la cola")} />
        </section>

        {/* En vivo */}
        <section className="panel studio__live">
          <header className="panel__head">
            <h3>Salir en vivo</h3>
          </header>
          <ol className="studio__steps">
            <li>En OBS: Ajustes → Emisión → Servicio <em>Personalizado</em>.</li>
            <li>Pega esta URL en "Servidor" (deja la clave vacía):</li>
          </ol>
          <div className="copy">
            <code>{ov?.live.streamKeyConfigured ? ov.live.srtUrl : "Falta RTMP_STREAM_KEY en .env"}</code>
            {ov?.live.streamKeyConfigured && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => navigator.clipboard.writeText(ov.live.srtUrl).then(() => flash("URL copiada"))}
              >
                Copiar
              </button>
            )}
          </div>
          <p className="panel__empty">Al empezar a transmitir, la radio entra en directo sin cortes; al parar, vuelve la música.</p>
        </section>
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function AddToQueue({ onAdd }: { onAdd: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResult[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setRes([]);
      return;
    }
    const ctl = new AbortController();
    const id = window.setTimeout(() => searchLibrary(q.trim(), ctl.signal).then((r) => !ctl.signal.aborted && setRes(r)), 250);
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
  }, [q]);
  return (
    <div className="studio__add">
      <label className="search">
        <span aria-hidden="true">＋</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Añadir a la cola: busca en la biblioteca…" />
      </label>
      {res.length > 0 && (
        <ul className="tracks results">
          {res.map((r) => (
            <li key={r.id} className="track">
              <Cover src={r.coverUrl} seed={r.id} label={r.title} className="track__cover" />
              <span className="track__text">
                <span className="track__title">{r.title}</span>
                <span className="track__artist">
                  {r.artist} · {clock(r.duration)}
                </span>
              </span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  onAdd(r.id);
                  setQ("");
                }}
              >
                Encolar
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
