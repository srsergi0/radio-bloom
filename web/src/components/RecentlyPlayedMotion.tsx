import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

type Track = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  file?: string;
  duration?: number;
  lastPlayedAt?: string;
};

function timeAgo(iso?: string) {
  if (!iso) return "never";
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function RecentlyPlayedMotion() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const firstRender = useRef(true);

  useEffect(() => {
    let alive = true;
    const fetchRecent = async () => {
      try {
        const r = await fetch("/api/library");
        if (!r.ok) return;
        const j = await r.json();
        const songs: Track[] = (j.data?.songs || j.data || []).filter((s: any) => s.file);
        const played = songs.filter((s) => s.lastPlayedAt).sort((a, b) => new Date(b.lastPlayedAt!).getTime() - new Date(a.lastPlayedAt!).getTime());
        const never = songs.filter((s) => !s.lastPlayedAt).slice(0, 4 - played.length);
        const list = [...played, ...never].slice(0, 4);
        if (!alive) return;
        setTracks(list);
        setTimeout(() => { firstRender.current = false; }, 60);
      } catch {}
    };
    fetchRecent();
    const id = setInterval(fetchRecent, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const positions: string[] = [
    "left:0;top:0;width:72%;z-index:1;",
    "right:0;top:60px;width:68%;z-index:2;",
    "left:0;top:180px;width:66%;z-index:3;",
    "right:10px;bottom:0;width:64%;z-index:4;",
  ];

  return (
    <div style={{ position: "relative", height: 480, marginTop: 16, overflow: "hidden" }}>
      <AnimatePresence initial={false}>
        {tracks.map((t, i) => (
          <motion.div
            key={t.id}
            layout
            initial={firstRender.current ? false : { opacity: 0, x: i % 2 === 0 ? -18 : 18, scale: 0.97, filter: "blur(6px)" }}
            animate={{ opacity: 1, x: 0, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: i % 2 === 0 ? -16 : 16, scale: 0.97, filter: "blur(6px)" }}
            transition={{ type: "spring", stiffness: 340, damping: 26, mass: 0.7, delay: i * 0.04 }}
            className="browser"
            style={{ position: "absolute", cssText: positions[i] } as any}
          >
            <div className="browser-bar">
              <span className="browser-dots"><span /><span /></span>
              <span className="browser-title">{t.file || t.id}</span>
              <span style={{ width: 20 }} />
            </div>
            <div style={{ padding: 10, background: "#fff", fontSize: 11 }}>
              <motion.b
                layout
                style={{ fontFamily: "Archivo Black, sans-serif", fontSize: 13, display: "block" }}
                initial={false}
                animate={{ opacity: 1 }}
              >
                {t.title}
              </motion.b>
              <span style={{ fontFamily: "Space Mono, monospace", fontSize: 10, opacity: 0.7 }}>
                {t.artist || "—"} {t.album ? `• ${t.album}` : ""}
              </span>
              <br />
              <motion.span
                initial={false}
                animate={{ opacity: 1 }}
                style={{ fontFamily: "Space Mono, monospace", fontSize: 9, background: "#d9d9d9", border: "1.5px solid #000", padding: "2px 6px", display: "inline-block", marginTop: 6 }}
              >
                {timeAgo(t.lastPlayedAt)} • {Math.round(t.duration || 0)}s
              </motion.span>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      {tracks.length === 0 && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Space Mono, monospace", fontSize: 11, border: "2px dashed #000", background: "#fff" }}>
          Loading history…
        </div>
      )}
    </div>
  );
}
