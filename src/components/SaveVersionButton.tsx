import { useState } from "react";
import { useLeague } from "@/state/league";
import { saveVersion } from "@/lib/versions";
import { extractVersionData } from "@/lib/league-export";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

export function SaveVersionButton({
  variant = "outline",
  label = "💾 SAVE VERSION",
  onSaved,
}: {
  variant?: "outline" | "secondary" | "default";
  label?: string;
  onSaved?: () => void;
}) {
  const { state } = useLeague();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultTitle = `Season ${state.season} · Week ${state.currentWeek}`;

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await saveVersion(title.trim() || defaultTitle, extractVersionData(state));
      setOpen(false);
      setTitle("");
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save version.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        onClick={() => setOpen(true)}
        title="Save a restorable snapshot of all league data (Team Editor data excluded)"
        className="font-semibold"
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save Version</DialogTitle>
            <DialogDescription>
              Archives all league data (schedule, results, commentary, standings, playoffs,
              contracts) — Team Editor rosters/budgets/lineups are not included.
            </DialogDescription>
          </DialogHeader>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Version title
            </label>
            <Input
              autoFocus
              value={title}
              placeholder={defaultTitle}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={handleSave} disabled={busy}>{busy ? "Saving…" : "Save Version"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
