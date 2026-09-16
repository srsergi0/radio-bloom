import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

type QueueItem = {
  rid: string;
  id?: string;
  title?: string;
  artist?: string;
  type: string;
  script?: string;
  file?: string;
};

export default function UpNextMotion() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const firstRender = useRef(true);

  useEffect(() => {
    let alive = true;
    const fetchQ = async () => {
      try {
        const r = await fetch("/api/stream/queue");
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        const next: QueueItem[] = (j.data || []).slice(0, 4);
        setItems(next);
        // después del primer fetch, permite animar entradas/salidas
        setTimeout(() => { firstRender.current = false; }, 50);
      } catch {}
    };
    fetchQ();
    const id = setInterval(fetchQ, 10000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, minHeight: 180 }}>
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((it) => {
          const isInter = it.type === "interludio";
          const title = isInter ? (it.script ? it.script.slice(0, 58) + "…" : "Interludio") : (it.title || "Untitled");
          const artist = isInter ? "—" : (it.artist || "—");
          const filename = it.id || it.file || `queue-${it.rid}`;
          const tag = isInter ? "INTERLUDIO" : "SONG";
          return (
            <motion.div
              key={it.rid}
              layout
              initial={firstRender.current ? false : { opacity: 0, y: 12, scale: 0.98, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -10, scale: 0.98, filter: "blur(4px)" }}
              transition={{ type: "spring", stiffness: 380, damping: 28, mass: 0.6 }}
              className="browser"
              style={{ overflow: "hidden" }}
            >
              <div className="browser-bar">
                <span className="browser-dots"><span /><span /></span>
                <span className="browser-title">{filename}</span>
                <span style={{ width: 20 }} />
              </div>
              <div style={{ height: 120, overflow: "hidden", borderBottom: "2px solid #000", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Space Mono, monospace", fontSize: 10 }}>
                <motion.span
                  initial={false}
                  animate={{ opacity: [0.7, 1, 0.7] }}
                  transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
                >
                  {tag}
                </motion.span>
              </div>
              <div style={{ padding: 12, background: "#fff" }}>
                <div style={{ fontFamily: "Archivo Black, sans-serif", fontSize: 13, lineHeight: 1.1 }}>{title}</div>
                <div style={{ fontFamily: "Space Mono, monospace", fontSize: 10, opacity: 0.7, marginTop: 4 }}>{artist}</div>
                <div style={{ marginTop: 6, fontFamily: "Space Mono, monospace", fontSize: 9, opacity: 0.5 }}>rid: {it.rid}</div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {items.length === 0 && (
        <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 32, border: "2px dashed #000", background: "#fff", fontFamily: "Space Mono, monospace", fontSize: 11 }}>
          Cola vacía — fallback sonando
        </div>
      )}
    </div>
  );
}
