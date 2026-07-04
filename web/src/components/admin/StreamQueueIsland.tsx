import { useEffect, useState, useRef } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Radio, Music, Calendar, Trash2, Loader2, X, Volume2, SkipForward } from "lucide-react";
import { api } from "@/components/admin/lib/api";
import type { StreamStatus, StreamQueueItem } from "@/components/admin/lib/types";
import { Button } from "@/components/admin/ui/button";
import { toast } from "sonner";

export function StreamQueueIsland() {
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [queue, setQueue] = useState<StreamQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [localElapsed, setLocalElapsed] = useState(0);

  const { setNodeRef, isOver } = useDroppable({
    id: "stream-queue",
  });

  const fetchData = async () => {
    try {
      const [statusRes, queueRes] = await Promise.all([
        api.get<StreamStatus>("/api/stream"),
        api.get<StreamQueueItem[]>("/api/stream/queue"),
      ]);

      if (statusRes.ok && statusRes.data) {
        setStatus(statusRes.data);
        setLocalElapsed(statusRes.data.elapsed);
      }
      if (queueRes.ok && queueRes.data) {
        setQueue(queueRes.data);
      }
    } catch (err) {
      console.error("Error fetching stream data:", err);
    } finally {
      setLoading(false);
    }
  };

  // Poll status every 3s
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);

    // Listen for custom queue updates triggered by dragging
    const handleUpdate = () => fetchData();
    window.addEventListener("stream-queue-updated", handleUpdate);

    return () => {
      clearInterval(interval);
      window.removeEventListener("stream-queue-updated", handleUpdate);
    };
  }, []);

  // Smooth local increment loop for elapsed progress
  useEffect(() => {
    if (!status || !status.playing || !status.duration) return;

    const interval = setInterval(() => {
      setLocalElapsed((prev) => {
        if (prev >= status.duration) return status.duration;
        return prev + 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [status?.playing, status?.duration]);

  const handleClearQueue = async () => {
    const ok = confirm("¿Estás seguro de que deseas eliminar toda la cola en vivo?");
    if (!ok) return;

    const res = await api.delete("/api/stream/queue");
    if (res.ok) {
      toast.success("Cola de transmisión limpia");
      fetchData();
    } else {
      toast.error(res.error || "No se pudo limpiar la cola");
    }
  };

  const handleRemoveTrack = async (rid: string, title: string) => {
    const res = await api.delete(`/api/stream/queue/${rid}`);
    if (res.ok) {
      toast.success(`Eliminado de la cola: "${title}"`);
      fetchData();
    } else {
      toast.error(res.error || "No se pudo eliminar el elemento");
    }
  };

  const handleSkip = async () => {
    const res = await api.post<{ action: string; nowPlaying: StreamStatus }>("/api/stream/skip");
    if (res.ok) {
      toast.success("Saltando canción actual...");
      fetchData();
    } else {
      toast.error(res.error || "No se pudo saltar la canción");
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const percent = status?.duration ? Math.min(100, (localElapsed / status.duration) * 100) : 0;

  return (
    <div className="h-44 border-t bg-card flex flex-col select-none shrink-0 relative z-10">
      <div className="flex h-full items-stretch divide-x divide-border">
        {/* NOW PLAYING CARD */}
        <div className="w-80 p-4 flex flex-col justify-between shrink-0 bg-zinc-950/20">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-primary uppercase">
              <span className="relative flex h-2 w-2">
                {status?.playing && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                )}
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
              </span>
              Ahora en vivo
            </div>
            {status?.playing && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-zinc-400 hover:text-primary transition-colors"
                onClick={handleSkip}
                title="Saltar pista actual"
              >
                <SkipForward className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {loading && !status ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : status?.currentTrack ? (
            <div className="flex-1 flex flex-col justify-center min-w-0">
              <div className="flex items-start gap-2">
                <Music className="h-4 w-4 text-zinc-500 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-zinc-100 truncate">
                    {status.title || "Pista sin título"}
                  </h4>
                  <p className="text-xs text-zinc-400 truncate mt-0.5">
                    {status.artist || "Artista desconocido"}
                  </p>
                </div>
              </div>

              {/* Progress bar */}
              <div className="mt-3">
                <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-1000 ease-linear rounded-full"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                  <span>{formatTime(localElapsed)}</span>
                  <span>{formatTime(status.duration)}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <Volume2 className="h-6 w-6 text-zinc-600 mb-1" />
              <span className="text-xs text-zinc-500">Transmisión en espera</span>
            </div>
          )}
        </div>

        {/* SCHEDULE CARD */}
        <div className="w-64 p-4 flex flex-col justify-between shrink-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-zinc-400 uppercase mb-2">
            <Calendar className="h-3.5 w-3.5" />
            Programado
          </div>

          <div className="flex-1 flex flex-col justify-center">
            {status?.activeLocutor ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-green-500" />
                  <span className="text-sm font-bold text-zinc-200">
                    {status.activeLocutor.name}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 pl-4 truncate">
                  Voz: {status.activeLocutor.voice}
                </p>
                <span className="inline-block text-[9px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-mono mt-1">
                  LOCUCIÓN DE IA ACTIVA
                </span>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-zinc-600" />
                  <span className="text-sm font-medium text-zinc-400">
                    Locutor de Reserva
                  </span>
                </div>
                <p className="text-xs text-zinc-500 pl-4">Programación regular de música</p>
              </div>
            )}
          </div>
        </div>

        {/* QUEUE HORIZONTAL CONTAINER (DROPPABLE TARGET) */}
        <div
          ref={setNodeRef}
          className={`flex-1 p-4 flex flex-col justify-between min-w-0 transition-colors duration-200 ${
            isOver ? "bg-primary/5 border-l-2 border-primary" : ""
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-zinc-400 uppercase">
              <Radio className="h-3.5 w-3.5" />
              Cola en vivo
              <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-mono">
                {queue.length} items
              </span>
            </div>
            {queue.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-zinc-500 hover:text-destructive hover:bg-destructive/10 transition-colors gap-1 px-2"
                onClick={handleClearQueue}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Limpiar cola
              </Button>
            )}
          </div>

          <div className="flex-1 overflow-x-auto flex items-center gap-3 py-1 pr-4 min-h-[76px] scrollbar-thin">
            {queue.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-zinc-800 rounded-lg py-4 text-center">
                <span className="text-xs text-zinc-500">Cola vacía</span>
                <span className="text-[10px] text-zinc-600 mt-0.5">
                  Arrastra canciones o interludios aquí para encolar en vivo
                </span>
              </div>
            ) : (
              queue.map((item) => {
                const isInter = item.type === "interludio";
                const isPending = (item as any).pending === true;
                const displayTitle = isInter && item.script
                  ? item.script.length > 60
                    ? `${item.script.substring(0, 60)}...`
                    : item.script
                  : item.title || item.rid;
                const displaySubtitle = isInter
                  ? (item.title && item.script ? item.title : undefined)
                  : (item.artist || undefined);

                return (
                  <div
                    key={item.rid}
                    className={`flex items-center gap-3 px-3 py-2 bg-zinc-950 border rounded-lg min-w-[200px] max-w-[240px] shrink-0 relative group transition-all duration-150 ${
                      isPending
                        ? "border-yellow-500/30 hover:border-yellow-500/60 animate-pulse"
                        : isInter
                        ? "border-green-500/30 hover:border-green-500"
                        : "border-red-500/30 hover:border-red-500"
                    }`}
                  >
                    <div
                      className={`absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-md ${
                        isPending ? "bg-yellow-500" : isInter ? "bg-green-500" : "bg-red-500"
                      }`}
                    />
                    <div className="flex-1 min-w-0 pl-1.5">
                      <h5 className="text-xs font-semibold text-zinc-200 truncate" title={isInter && item.script ? item.script : item.title}>
                        {displayTitle}
                      </h5>
                      {isPending ? (
                        <p className="text-[10px] text-yellow-500/80 flex items-center gap-1 mt-0.5">
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          Procesando...
                        </p>
                      ) : (
                        displaySubtitle && (
                          <p className="text-[10px] text-zinc-500 truncate mt-0.5" title={displaySubtitle}>
                            {displaySubtitle}
                          </p>
                        )
                      )}
                    </div>
                    {!isPending && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-destructive hover:bg-destructive/10 transition-all rounded-md shrink-0"
                        onClick={() => handleRemoveTrack(item.rid, item.title)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
