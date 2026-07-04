import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/admin/ui/dialog";
import { Button } from "@/components/admin/ui/button";
import { Input } from "@/components/admin/ui/input";

interface InterludioEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (title: string, script: string) => void;
  defaultTitle?: string;
  defaultScript?: string;
}

export function InterludioEditor({
  open,
  onOpenChange,
  onSave,
  defaultTitle = "",
  defaultScript = "",
}: InterludioEditorProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [script, setScript] = useState(defaultScript);

  const handleSave = () => {
    if (!title.trim()) return;
    onSave(title.trim(), script.trim());
    onOpenChange(false);
    setTitle(defaultTitle);
    setScript(defaultScript);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{defaultTitle ? "Edit Interludio" : "Add Interludio"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className="text-sm font-medium block mb-1">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Interludio name..."
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Text / Script</label>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="Text that will be synthesized to speech..."
              className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm resize-y"
              rows={5}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!title.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
