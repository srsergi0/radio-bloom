import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, ListMusic, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/admin/ui/card";
import { Button } from "@/components/admin/ui/button";
import { Input } from "@/components/admin/ui/input";
import { Badge } from "@/components/admin/ui/badge";
import { api } from "@/components/admin/lib/api";
import type { Playlist } from "@/components/admin/lib/types";
import { toast } from "sonner";

export function PlaylistList() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<Playlist[]>("/api/playlists").then((res) => {
      if (res.ok) setPlaylists(res.data!);
    });
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const res = await api.post<Playlist>("/api/playlists", { name: newName.trim() });
    if (res.ok && res.data) {
      setPlaylists((prev) => [res.data!, ...prev]);
      setNewName("");
      toast.success("Playlist created");
    } else {
      toast.error(res.error || "Failed to create playlist");
    }
    setCreating(false);
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Playlists</h2>

      <div className="flex gap-2 mb-6">
        <Input
          placeholder="New playlist name..."
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        />
        <Button onClick={handleCreate} disabled={creating || !newName.trim()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create
        </Button>
      </div>

      <div className="space-y-2">
        {playlists.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            No playlists yet. Create one to get started.
          </p>
        )}
        {playlists.map((pl) => (
          <Card
            key={pl.id}
            className="cursor-pointer hover:bg-accent/50 transition-colors"
            onClick={() => navigate(`/playlist/${pl.id}`)}
          >
            <CardHeader className="flex flex-row items-center justify-between py-3 px-4">
              <div className="flex items-center gap-3">
                <ListMusic className="h-5 w-5 text-muted-foreground" />
                <div>
                  <CardTitle className="text-base">{pl.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {pl.tracks?.length || 0} tracks
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {pl.played && (
                  <Badge variant="destructive" className="bg-red-900/50 text-red-200 border-red-800 text-[10px] py-0 h-5">
                    Reproducida
                  </Badge>
                )}
                <Badge variant="secondary" className="text-xs">
                  {new Date(pl.updatedAt).toLocaleDateString()}
                </Badge>
              </div>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
