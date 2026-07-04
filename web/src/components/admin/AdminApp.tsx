import { useState, useMemo } from "react";
import { BrowserRouter, Routes, Route, useLocation, matchPath } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragCancelEvent,
} from "@dnd-kit/core";
import { Toaster, toast } from "sonner";
import { TooltipProvider } from "@/components/admin/ui/tooltip";
import { Separator } from "@/components/admin/ui/separator";
import { SidebarTree } from "@/components/admin/SidebarTree";
import { PlaylistList } from "@/components/admin/PlaylistList";
import { PlaylistDetail } from "@/components/admin/PlaylistDetail";
import { PlaylistCtx } from "@/components/admin/PlaylistContext";
import { StreamQueueIsland } from "@/components/admin/StreamQueueIsland";
import { api } from "@/components/admin/lib/api";
import type { Track } from "@/components/admin/lib/types";

function AdminLayout() {
  const location = useLocation();
  const match = matchPath("/playlist/:id", location.pathname);
  const currentPlaylistId = match?.params?.id || null;

  const [activeDraggedTrack, setActiveDraggedTrack] = useState<Track | null>(null);
  const [handlerMap, setHandlerMap] = useState<{
    onDropLibraryTrack?: (track: Track) => Promise<void>;
    onReorderTracks?: (activeId: string, overId: string) => Promise<void>;
  }>({});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const ctxValue = useMemo(
    () => ({
      playlistId: currentPlaylistId,
      handlers: handlerMap,
      registerHandlers: setHandlerMap,
    }),
    [currentPlaylistId, handlerMap]
  );

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    if (id.startsWith("lib-")) {
      setActiveDraggedTrack(event.active.data.current?.track as Track);
    }
  };

  const handleDragCancel = (_event: DragCancelEvent) => {
    setActiveDraggedTrack(null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDraggedTrack(null);
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    if (activeId.startsWith("lib-")) {
      const track = active.data.current?.track as Track;
      if (!track) return;

      if (overId === "stream-queue") {
        const res = await api.post("/api/stream/queue", { id: track.id });
        if (res.ok) {
          toast.success(`Enqueued in live stream: "${track.title}"`);
          window.dispatchEvent(new CustomEvent("stream-queue-updated"));
        } else {
          toast.error(res.error || "Failed to enqueue track");
        }
        return;
      }

      const isOverQueue = overId === "playlist-queue" || over.data.current?.type === "playlist-track";
      if (isOverQueue && handlerMap.onDropLibraryTrack) {
        await handlerMap.onDropLibraryTrack(track);
      }
      return;
    }

    if (activeId !== overId && handlerMap.onReorderTracks) {
      await handlerMap.onReorderTracks(activeId, overId);
    }
  };

  return (
    <PlaylistCtx.Provider value={ctxValue}>
      <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex h-screen bg-background">
        <aside className="w-72 border-r bg-card flex flex-col shrink-0">
          <div className="p-4 flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-primary" />
            <span className="font-bold">Radio Bloom Admin</span>
          </div>
          <Separator />
          <SidebarTree />
        </aside>
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <main className="flex-1 overflow-auto">
            <Routes>
              <Route path="/" element={<PlaylistList />} />
              <Route path="/playlist/:id" element={<PlaylistDetail />} />
            </Routes>
          </main>
          <StreamQueueIsland />
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDraggedTrack && (
          <div className="flex items-center gap-2 px-3 py-2 bg-card border rounded-lg shadow-lg max-w-xs">
            <span className="text-sm font-medium truncate">{activeDraggedTrack.title}</span>
          </div>
        )}
      </DragOverlay>
      </DndContext>
    </PlaylistCtx.Provider>
  );
}

export function AdminApp() {
  return (
    <TooltipProvider>
      <BrowserRouter basename="/admin">
        <AdminLayout />
      </BrowserRouter>
      <Toaster richColors position="bottom-right" />
    </TooltipProvider>
  );
}
