import { useEffect, useMemo, useRef, useState } from "react";
import {
  useLeague, isManualOnly, isWeekComplete, type FixtureEntry,
} from "@/state/league";
import { SimulationTerminal } from "@/components/SimulationTerminal";
import { MatchCommentaryDialog } from "@/components/MatchCommentaryDialog";
import { downloadWeekExport } from "@/lib/league-export";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function ScheduleSuite() {
  const { state, setResult } = useLeague();
  const [simFixture, setSimFixture] = useState<FixtureEntry | null>(null);
  const [manualFixture, setManualFixture] = useState<FixtureEntry | null>(null);
  const [commentaryFixture, setCommentaryFixture] = useState<FixtureEntry | null>(null);
  const activeWeekRef = useRef<HTMLElement>(null);

  const weeks = useMemo(() => {
    const map = new Map<number, FixtureEntry[]>();
    for (const f of state.fixtures) {
      if (!map.has(f.week)) map.set(f.week, []);
      map.get(f.week)!.push(f);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [state.fixtures]);

  // On open, jump straight to the current week instead of starting at Week 1.
  useEffect(() => {
    const el = activeWeekRef.current;
    if (el) {
      el.scrollIntoView({ block: "start", behavior: "auto" });
    }
    // Run once after the schedule first paints for the active week.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentWeek, weeks.length]);


  const week12Done = isWeekComplete(state, 12);
  const finalFourExists = state.fixtures.some((f) => f.week >= 13);
  const week16Done = isWeekComplete(state, 16);
  const preSeason = state.fixtures.length === 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">
            Season <span className="font-semibold text-foreground">{state.season}</span>
            {" · "}Active week: <span className="font-semibold text-foreground">Week {state.currentWeek}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {preSeason
              ? "Pre-season — schedule Weeks 1–12 in the Match Scheduling suite"
              : state.currentWeek <= 12
              ? `${12 - state.currentWeek + 1} regular weeks + Final Four remaining`
              : "Final Four phase"}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Mistake? Use the <span className="font-semibold text-foreground">UNDO</span> button in the header.
        </p>
      </div>

      {preSeason && (
        <div className="mb-6 rounded-xl border bg-panel/50 p-6 text-center text-sm text-muted-foreground">
          No fixtures yet. Open the <strong className="text-foreground">Match Scheduling</strong> suite to
          run the draft / Team Editor changes and lay down a fresh Weeks 1–12 schedule.
        </div>
      )}

      <div className="space-y-6">
        {weeks.map(([week, fixtures]) => {
          const isActive = week === state.currentWeek;
          const isFinalFour = week >= 13;
          const weekComplete = fixtures.length > 0 && fixtures.every((f) => state.results[f.id]);
          return (
            <section
              key={week}
              ref={isActive ? activeWeekRef : undefined}
              className="rounded-xl border bg-card scroll-mt-44"
            >
              <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                <h3 className="text-sm font-bold uppercase tracking-wide">
                  {isFinalFour ? `Final Four · Week ${week}` : `Week ${week}`}
                </h3>
                <div className="flex items-center gap-2">
                  {weekComplete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] font-semibold text-primary"
                      onClick={() => downloadWeekExport(state, week)}
                      title="Download this week's results, commentary and Team Editor data as JSON"
                    >
                      ⬇ EXPORT FINISHED WEEK DATA
                    </Button>
                  )}
                  {isActive && (
                    <span className="rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-bold uppercase text-primary-foreground">
                      Active
                    </span>
                  )}
                </div>
              </header>
              <ul className="divide-y">
                {fixtures.map((fx) => {
                  const r = state.results[fx.id];
                  const manualOnly = isManualOnly(fx.home, fx.away);
                  return (
                    <li key={fx.id} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 py-2.5 text-sm">
                      <span className="truncate text-right font-medium">{fx.home}</span>
                      <span className="min-w-[64px] text-center font-mono font-bold tabular-nums">
                        {r ? `${r.homeGoals} - ${r.awayGoals}` : "vs"}
                      </span>
                      <span className="truncate text-left font-medium">{fx.away}</span>

                      {isActive && !r && (
                        <div className="col-span-3 mt-1 flex flex-wrap justify-center gap-2">
                          {!manualOnly && (
                            <Button size="sm" variant="secondary" onClick={() => setSimFixture(fx)}>
                              SIMULATE
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => setManualFixture(fx)}>
                            ENTER MATCH RESULT
                          </Button>
                          {manualOnly && (
                            <span className="self-center text-[10px] uppercase text-muted-foreground">
                              Manual entry only
                            </span>
                          )}
                        </div>
                      )}
                      {r && (
                        <div className="col-span-3 mt-0.5 flex flex-wrap items-center justify-center gap-3">
                          <span className="text-[10px] uppercase text-muted-foreground">
                            {r.method === "SIM" ? "Simulated" : "Manual entry"}
                          </span>
                          {r.method === "SIM" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-[11px] font-semibold text-primary"
                              onClick={() => setCommentaryFixture(fx)}
                            >
                              VIEW MATCH COMMENTARY
                            </Button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {!preSeason && state.currentWeek === 12 && !week12Done && (
          <p className="text-center text-xs text-muted-foreground">
            Final Four (Weeks 13–16) unlock once Week 12 is fully recorded.
          </p>
        )}
        {week12Done && !finalFourExists && (
          <p className="text-center text-xs font-semibold text-primary">
            Week 12 complete — open the Match Scheduling suite to build the Final Four.
          </p>
        )}
        {week16Done && (
          <p className="text-center text-xs font-semibold text-primary">
            Regular season complete — open the Playoffs suite to seed the top 14.
          </p>
        )}
      </div>

      {/* Full-screen simulator overlay */}
      {simFixture && (
        <SimulationTerminal
          initialHome={simFixture.home}
          initialAway={simFixture.away}
          lockTeams
          defaultTempoIndex={1}
          fullscreen
          onComplete={(h, a, payload) => {
            setResult(simFixture.id, h, a, "SIM", payload);
            setSimFixture(null);
          }}
          onExit={() => setSimFixture(null)}
        />
      )}

      {/* Manual entry modal */}
      <ManualEntryDialog
        fixture={manualFixture}
        onClose={() => setManualFixture(null)}
        onSave={(h, a) => {
          if (manualFixture) setResult(manualFixture.id, h, a, "MANUAL");
          setManualFixture(null);
        }}
      />

      {/* Match commentary viewer */}
      <MatchCommentaryDialog
        open={!!commentaryFixture}
        onClose={() => setCommentaryFixture(null)}
        title={commentaryFixture ? `${commentaryFixture.home} vs ${commentaryFixture.away}` : ""}
        log={commentaryFixture ? state.payloads[commentaryFixture.id]?.log : undefined}
      />
    </div>
  );
}

function ManualEntryDialog({
  fixture, onClose, onSave,
}: {
  fixture: FixtureEntry | null;
  onClose: () => void;
  onSave: (h: number, a: number) => void;
}) {
  const [h, setH] = useState("0");
  const [a, setA] = useState("0");
  // Reset the score inputs whenever a different fixture is opened, so stale
  // scores from a previous entry never carry over.
  useEffect(() => { setH("0"); setA("0"); }, [fixture?.id]);
  return (
    <Dialog open={!!fixture} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Enter Match Result</DialogTitle>
        </DialogHeader>
        {fixture && (
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
            <div>
              <div className="mb-1 truncate text-xs font-semibold">{fixture.home}</div>
              <Input type="number" min={0} value={h} onChange={(e) => setH(e.target.value)} className="text-center" />
            </div>
            <span className="pb-2 font-bold text-muted-foreground">-</span>
            <div>
              <div className="mb-1 truncate text-xs font-semibold">{fixture.away}</div>
              <Input type="number" min={0} value={a} onChange={(e) => setA(e.target.value)} className="text-center" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(Math.max(0, parseInt(h) || 0), Math.max(0, parseInt(a) || 0))}>
            Log Result
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
