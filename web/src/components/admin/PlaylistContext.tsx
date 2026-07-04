import { createContext, useContext } from "react";
import type { PlaylistTrack, Track } from "@/components/admin/lib/types";

export interface DragHandlers {
  onDropLibraryTrack?: (track: Track) => Promise<void>;
  onReorderTracks?: (activeId: string, overId: string) => Promise<void>;
}

export interface PlaylistCtxValue {
  playlistId: string | null;
  handlers: DragHandlers;
  registerHandlers: (h: DragHandlers) => void;
}

export const PlaylistCtx = createContext<PlaylistCtxValue>({
  playlistId: null,
  handlers: {},
  registerHandlers: () => {},
});

export const usePlaylistCtx = () => useContext(PlaylistCtx);
