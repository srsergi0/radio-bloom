import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, FileAudio, FileText, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/admin/ui/dropdown-menu";
import type { PlaylistTrack } from "@/components/admin/lib/types";

interface Props {
  track: PlaylistTrack;
  onEdit: (track: PlaylistTrack) => void;
  onDelete: (trackId: string) => void;
}

export function PlaylistTrackItem({ track, onEdit, onDelete }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: track.id,
    data: {
      type: "playlist-track",
      trackId: track.id,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const Icon = track.type === "interludio" ? FileText : FileAudio;
  const hasAudio = !!track.file;
  const hasScript = !!track.script;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-3 py-2 border rounded-lg bg-card hover:bg-accent/30 transition-colors group"
    >
      <button
        className="cursor-grab active:cursor-grabbing touch-none shrink-0"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4 text-muted-foreground" />
      </button>

      <Icon className="h-4 w-4 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{track.title}</span>
          {!hasAudio && hasScript && (
            <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium shrink-0">
              TTS
            </span>
          )}
          {hasAudio && (
            <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium shrink-0">
              audio
            </span>
          )}
          {track.artist && (
            <span className="text-xs text-muted-foreground truncate">{track.artist}</span>
          )}
        </div>
        {hasScript && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{track.script}</p>
        )}
      </div>
      {track.duration > 0 && (
        <span className="text-xs text-muted-foreground shrink-0">
          {formatDuration(track.duration)}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onEdit(track)}>
            <Pencil className="h-4 w-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onDelete(track.id)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
