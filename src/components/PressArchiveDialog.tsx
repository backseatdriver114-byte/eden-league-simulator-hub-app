// Newsroom Press Conference Archives — browse every recorded press
// conference (user-controlled AND behind-the-scenes AI) grouped by week.
// User-team conferences are highlighted blue. AI conferences that mention
// any user-controlled team are highlighted red.
import { useMemo, useState } from "react";
import { useLeague, type PressArchiveEntry } from "@/state/league";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props { open: boolean; onClose: () => void; }

interface WeekKey { season: number; week: number; }
function keyOf(k: WeekKey): string { return `S${k.season}W${k.week}`; }

export function PressArchiveDialog({ open, onClose }: Props) {
  const { state } = useLeague();
  const archive = state.pressArchive ?? [];
  const exempt = state.settings?.contractExemptTeams ?? [];
  const isUserTeam = (t: string) => exempt.includes(t);

  const [week, setWeek] = useState<WeekKey | null>(null);
  const [team, setTeam] = useState<string | null>(null);

  // Group entries by (season, week) -> team -> entries[]
  const grouped = useMemo(() => {
    const m = new Map<string, { season: number; week: number; teams: Map<string, PressArchiveEntry[]> }>();
    for (const e of archive) {
      const k = keyOf({ season: e.season, week: e.week });
      let bucket = m.get(k);
      if (!bucket) {
        bucket = { season: e.season, week: e.week, teams: new Map() };
        m.set(k, bucket);
      }
      const arr = bucket.teams.get(e.team) ?? [];
      arr.push(e);
      bucket.teams.set(e.team, arr);
    }
    return [...m.values()].sort((a, b) => b.season - a.season || b.week - a.week);
  }, [archive]);

  // Determine whether a team's conference for the selected week mentions any
  // user club. We treat a mention as: target.team or target.name in exempt set.
  function mentionsUser(entries: PressArchiveEntry[]): boolean {
    for (const e of entries) {
      for (const t of e.targets ?? []) {
        if (t.kind === "team" && t.name && isUserTeam(t.name)) return true;
        if ((t.kind === "player" || t.kind === "manager") && t.team && isUserTeam(t.team)) return true;
      }
    }
    return false;
  }

  const activeWeek = week
    ? grouped.find((g) => g.season === week.season && g.week === week.week)
    : null;
  const activeEntries = activeWeek && team ? activeWeek.teams.get(team) ?? [] : [];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setWeek(null); setTeam(null); onClose(); } }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>📚 Press Conference Archives</DialogTitle>
        </DialogHeader>

        {!week && (
          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              Pick a finished week to see every team's press conference for that week.
            </p>
            {grouped.length === 0 ? (
              <p className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
                No press conferences on record yet.
              </p>
            ) : (
              <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-lg border bg-card">
                {grouped.map((g) => (
                  <li key={keyOf(g)}>
                    <button
                      onClick={() => setWeek({ season: g.season, week: g.week })}
                      className="flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-muted"
                    >
                      <span className="font-semibold">Season {g.season} · Week {g.week}</span>
                      <span className="text-xs text-muted-foreground">{g.teams.size} team{g.teams.size === 1 ? "" : "s"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {week && !team && activeWeek && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setWeek(null)} className="mb-2 text-xs">← Back to weeks</Button>
            <div className="mb-2 text-xs text-muted-foreground">
              S{activeWeek.season} · Week {activeWeek.week} — pick a club's press conference. <span className="text-highlight-blue font-semibold">Blue</span> = your club. <span className="text-highlight-red font-semibold">Red</span> = AI manager who mentioned one of your clubs.
            </div>
            <ul className="max-h-[60vh] grid grid-cols-2 gap-1 overflow-y-auto rounded-lg border bg-card p-2 sm:grid-cols-3">
              {[...activeWeek.teams.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([tm, entries]) => {
                  const user = isUserTeam(tm);
                  const mention = !user && mentionsUser(entries);
                  const cls = user
                    ? "border-highlight-blue/60 bg-highlight-blue/10 text-highlight-blue"
                    : mention
                      ? "border-highlight-red/60 bg-highlight-red/10 text-highlight-red"
                      : "border-border hover:bg-muted";
                  return (
                    <li key={tm}>
                      <button
                        onClick={() => setTeam(tm)}
                        className={`flex w-full flex-col items-start rounded-md border px-2 py-1.5 text-left text-xs ${cls}`}
                      >
                        <span className="font-semibold">{tm}</span>
                        <span className="text-[10px] opacity-80">{entries[0]?.managerName} · {entries.length} Q&amp;A</span>
                      </button>
                    </li>
                  );
                })}
            </ul>
          </div>
        )}

        {week && team && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setTeam(null)} className="mb-2 text-xs">← Back to teams</Button>
            <div className="mb-2 text-xs">
              <span className="font-bold">{team}</span>{" "}
              <span className="text-muted-foreground">— S{week.season} · Week {week.week} · {activeEntries[0]?.managerName}</span>
            </div>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto rounded-lg border bg-card p-3">
              {activeEntries.length === 0 ? (
                <p className="text-xs text-muted-foreground">No exchanges recorded.</p>
              ) : activeEntries.map((e) => (
                <div key={e.id} className="rounded-lg border bg-background p-2 text-xs">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    {e.context === "pre" ? "Pre-match" : e.context === "post" ? "Post-match" : "General"}
                  </div>
                  <p className="font-semibold text-foreground">Q: {e.question}</p>
                  <p className="mt-1 text-foreground">A: {e.answer}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
