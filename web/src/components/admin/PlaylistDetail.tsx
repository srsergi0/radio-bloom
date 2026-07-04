import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { ArrowLeft, Play, Shuffle, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/admin/ui/button";
import { Badge } from "@/components/admin/ui/badge";
import { ScrollArea } from "@/components/admin/ui/scroll-area";
import { Separator } from "@/components/admin/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/admin/ui/dropdown-menu";
import { PlaylistTrackItem } from "@/components/admin/PlaylistTrackItem";
import { InterludioEditor } from "@/components/admin/InterludioEditor";
import { usePlaylistCtx } from "@/components/admin/PlaylistContext";
import { api } from "@/components/admin/lib/api";
import type { Playlist, PlaylistTrack, Track } from "@/components/admin/lib/types";
import { toast } from "sonner";

export function PlaylistDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [interludioOpen, setInterludioOpen] = useState(false);
  const [editTrack, setEditTrack] = useState<PlaylistTrack | null>(null);
  const [playing, setPlaying] = useState(false);

  const { registerHandlers } = usePlaylistCtx();

  const loadPlaylist = useCallback(() => {
    if (!id) return;
    api.get<Playlist>(`/api/playlists/${id}`).then((res) => {
      if (res.ok) setPlaylist(res.data!);
      else if (res.error) toast.error(res.error);
    });
  }, [id]);

  useEffect(() => {
    loadPlaylist();
  }, [loadPlaylist]);

  useEffect(() => {
    if (!id) return;
    registerHandlers({
      onDropLibraryTrack: async (track: Track) => {
        const res = await api.post<PlaylistTrack>(`/api/playlists/${id}/tracks`, {
          libraryTrackId: track.id,
        });
        if (res.ok) {
          loadPlaylist();
          toast.success(`Added "${track.title}"`);
        } else {
          toast.error(res.error || "Failed to add track");
        }
      },
      onReorderTracks: async (activeId: string, overId: string) => {
        if (!id) return;
        const res = await api.get<Playlist>(`/api/playlists/${id}`);
        if (!res.ok || !res.data) return;
        const tracks = res.data.tracks;
        const oldIndex = tracks.findIndex((t) => t.id === activeId);
        const newIndex = tracks.findIndex((t) => t.id === overId);
        if (oldIndex === -1 || newIndex === -1) return;
        const reordered = arrayMove(tracks, oldIndex, newIndex);
        const trackIds = reordered.map((t) => t.id);
        setPlaylist((prev) => (prev ? { ...prev, tracks: reordered } : null));
        const reorderRes = await api.put(`/api/playlists/${id}/tracks/reorder`, {
          trackIds,
        });
        if (!reorderRes.ok) {
          loadPlaylist();
          toast.error("Reorder failed");
        }
      },
    });
    return () => registerHandlers({});
  }, [id, registerHandlers, loadPlaylist]);

  const { setNodeRef, isOver } = useDroppable({ id: "playlist-queue" });

  const handleAddInterludio = async (title: string, script: string) => {
    if (!id) return;
    const res = await api.post<PlaylistTrack>(`/api/playlists/${id}/tracks`, {
      type: "interludio",
      title,
      script,
    });
    if (res.ok) {
      loadPlaylist();
      toast.success("Interludio added");
    } else {
      toast.error(res.error || "Failed to add interludio");
    }
  };

  const handleEditInterludio = async (title: string, script: string) => {
    if (!id || !editTrack) return;
    const res = await api.put(`/api/playlists/${id}/tracks/${editTrack.id}`, {
      title,
      script,
    });
    if (res.ok) {
      loadPlaylist();
      toast.success("Interludio updated");
    } else {
      toast.error(res.error || "Failed to update interludio");
    }
    setEditTrack(null);
  };

  const handleDeleteTrack = async (trackId: string) => {
    if (!id) return;
    const res = await api.delete(`/api/playlists/${id}/tracks/${trackId}`);
    if (res.ok) {
      loadPlaylist();
      toast.success("Track removed");
    } else {
      toast.error(res.error || "Failed to remove track");
    }
  };

  const handlePlay = async (shuffle: boolean = false) => {
    if (!id) return;
    setPlaying(true);
    const res = await api.post(`/api/playlists/${id}/play`, { shuffle, force: true });
    setPlaying(false);
    if (res.ok) {
      toast.success(
        `Playing: ${res.data?.queued} tracks queued${
          res.data?.skipped ? `, ${res.data.skipped} skipped` : ""
        }`
      );
    } else {
      toast.error(res.error || "Failed to play");
    }
  };

  if (!playlist) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto h-full flex flex-col">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h2 className="text-2xl font-bold flex-1 flex items-center gap-2">
          {playlist.name}
          {playlist.played && (
            <Badge variant="destructive" className="bg-red-900/50 text-red-200 border-red-800 text-[10px] py-0 px-2 h-5">
              Reproducida
            </Badge>
          )}
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="default" size="sm" disabled={playing || playlist.tracks.length === 0}>
              {playing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Play
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handlePlay(false)}>
              <Play className="h-4 w-4" />
              Play in order
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlePlay(true)}>
              <Shuffle className="h-4 w-4" />
              Shuffle & play
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-muted-foreground">
          {playlist.tracks.length} track{playlist.tracks.length !== 1 ? "s" : ""}
        </span>
        <Button variant="outline" size="sm" onClick={() => setInterludioOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Interludio
        </Button>
      </div>

      <Separator className="mb-3" />

      <div
        ref={setNodeRef}
        className={`flex-1 rounded-lg border-2 border-dashed transition-colors ${
          isOver
            ? "border-primary bg-primary/5"
            : playlist.tracks.length === 0
            ? "border-zinc-800 bg-zinc-950/20"
            : "border-transparent"
        }`}
      >
        <ScrollArea className="h-[calc(100vh-320px)]">
          <div className="space-y-1.5 p-1">
            <SortableContext
              items={playlist.tracks.map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              {playlist.tracks.length === 0 && (
                <div className="text-center py-16 text-muted-foreground">
                  <p className="text-sm">Empty queue</p>
                  <p className="text-xs mt-1">Drag songs from the sidebar or add interludios</p>
                </div>
              )}
              {playlist.tracks.map((track) => (
                <PlaylistTrackItem
                  key={track.id}
                  track={track}
                  onEdit={(t) => {
                    if (t.type === "interludio") setEditTrack(t);
                  }}
                  onDelete={handleDeleteTrack}
                />
              ))}
            </SortableContext>
          </div>
        </ScrollArea>
      </div>

      <InterludioEditor
        open={interludioOpen}
        onOpenChange={setInterludioOpen}
        onSave={handleAddInterludio}
      />

      <InterludioEditor
        open={!!editTrack}
        onOpenChange={(open) => {
          if (!open) setEditTrack(null);
        }}
        defaultTitle={editTrack?.title || ""}
        defaultScript={editTrack?.script || ""}
        onSave={handleEditInterludio}
      />
    </div>
  );
}
