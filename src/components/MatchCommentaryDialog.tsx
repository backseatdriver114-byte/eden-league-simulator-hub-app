import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  log?: string[];
}

export function MatchCommentaryDialog({ open, onClose, title, log }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Full match commentary</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-lg border bg-console-bg p-4 font-mono text-xs leading-relaxed text-console-fg">
          {log && log.length > 0 ? (
            log.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)
          ) : (
            <span className="text-muted-foreground">
              No commentary was recorded for this match (manual entries and matches
              played before this feature have no commentary).
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
