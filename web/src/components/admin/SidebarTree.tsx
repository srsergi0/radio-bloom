import { useEffect, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { ChevronRight, ChevronDown, Folder, FileAudio, FileText, GripVertical } from "lucide-react";
import { ScrollArea } from "@/components/admin/ui/scroll-area";
import { api } from "@/components/admin/lib/api";
import type { LibraryTree, FileTreeNode, Track } from "@/components/admin/lib/types";

function TreeNode({
  node,
  depth,
  defaultOpen,
}: {
  node: FileTreeNode;
  depth: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(depth < 2 || defaultOpen);

  const hasChildren = node.children && node.children.length > 0;
  const hasTracks = node.tracks && node.tracks.length > 0;

  return (
    <div>
      {node.name && (
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 w-full px-2 py-1 hover:bg-accent/50 rounded-md text-left text-sm text-zinc-300 transition-colors duration-150 group"
          style={{ paddingLeft: depth * 12 + 6 }}
        >
          {hasChildren ? (
            open ? (
              <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
            )
          ) : (
            <span className="w-3.5" />
          )}
          <Folder className="h-4 w-4 text-primary shrink-0" />
          <span className="truncate">{node.name}</span>
          {hasTracks && (
            <span className="text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground ml-auto group-hover:bg-accent transition-colors">
              {node.tracks!.length}
            </span>
          )}
        </button>
      )}
      {open && hasChildren &&
        node.children!.map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} defaultOpen={false} />
        ))}
      {open &&
        hasTracks &&
        node.tracks!.map((track) => (
          <DraggableTrack key={track.id} track={track} depth={depth + 1} />
        ))}
    </div>
  );
}

function DraggableTrack({ track, depth }: { track: Track; depth: number }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `lib-${track.id}`,
    data: { type: "library-track", track },
  });

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, opacity: isDragging ? 0.5 : 1 }
    : undefined;

  const Icon = track.type === "interludio" ? FileText : FileAudio;

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, paddingLeft: depth * 12 + 6 }}
      className="flex items-center gap-2 px-2 py-1 hover:bg-accent/50 rounded-md text-sm text-zinc-300 cursor-grab active:cursor-grabbing transition-colors duration-150 group"
      {...listeners}
      {...attributes}
    >
      <GripVertical className="h-3.5 w-3.5 text-zinc-500 opacity-30 group-hover:opacity-100 transition-opacity shrink-0" />
      <Icon className="h-4 w-4 text-zinc-400 shrink-0" />
      <span className="truncate flex-1">{track.title}</span>
      <span className="text-xs text-zinc-500 shrink-0">
        {formatDuration(track.duration)}
      </span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function SidebarTree() {
  const [tree, setTree] = useState<LibraryTree | null>(null);

  useEffect(() => {
    api.get<LibraryTree>("/api/library/tree").then((res) => {
      if (res.ok) setTree(res.data!);
    });
  }, []);

  if (!tree) return <div className="p-4 text-sm text-muted-foreground">Loading...</div>;

  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        <div className="flex items-center gap-2 mb-2 px-1">
          <FileAudio className="h-4 w-4" />
          <span className="font-semibold text-sm">Songs</span>
        </div>
        <TreeNode node={tree.songs} depth={0} defaultOpen />
        <div className="flex items-center gap-2 mb-2 mt-4 px-1">
          <FileText className="h-4 w-4" />
          <span className="font-semibold text-sm">Interludios</span>
        </div>
        <TreeNode node={tree.interludios} depth={0} defaultOpen />
      </div>
    </ScrollArea>
  );
}
