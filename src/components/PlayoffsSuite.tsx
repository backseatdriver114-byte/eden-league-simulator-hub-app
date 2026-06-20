import { useEffect, useState } from "react";
import {
  useLeague, isManualOnly, isWeekComplete, matchWinner,
  PLAYOFF_ROUND_NAMES, type PlayoffMatch,
} from "@/state/league";
import { SimulationTerminal } from "@/components/SimulationTerminal";
import { MatchCommentaryDialog } from "@/components/MatchCommentaryDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function PlayoffsSuite() {
  const { state, generatePlayoffs, setPlayoffResult } = useLeague();
  const [simMatch, setSimMatch] = useState<PlayoffMatch | null>(null);
  const [manualMatch, setManualMatch] = useState<PlayoffMatch | null>(null);
  const [commentaryMatch, setCommentaryMatch] = useState<PlayoffMatch | null>(null);

  const week16Done = isWeekComplete(state, 16);
  const playoffs = state.playoffs;

  if (!playoffs) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center">
        {week16Done ? (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              The regular season and Final Four are complete. Seed the top 14 teams and build the
              bracket using NFL-style reseeding (seeds 1 &amp; 2 receive a Wild Card bye).
            </p>
            <Button onClick={generatePlayoffs} className="px-6 font-semibold">
              GENERATE PLAYOFF BRACKET
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Playoffs unlock once Week 16 (the final week of the Final Four) is fully recorded.
          </p>
        )}
      </div>
    );
  }

  // The latest round still needing results is the only one with active controls.
  const activeRoundIdx = playoffs.rounds.findIndex(
    (round) => round.some((m) => !matchWinner(m))
  );

  return (
    <div>
      {playoffs.champion && (
        <div className="mb-6 rounded-xl border-2 border-primary bg-accent/40 p-6 text-center">
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Season {state.season} Champion
          </div>
          <div className="mt-1 text-2xl font-extrabold text-primary">{playoffs.champion}</div>
        </div>
      )}

      <div className="mb-6 overflow-x-auto rounded-xl border bg-card">
        <div className="border-b px-4 py-2.5 text-sm font-bold uppercase tracking-wide">
          Top 14 Seeds
        </div>
        <ul className="grid grid-cols-2 gap-x-4 p-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
          {playoffs.seeds.map((team, i) => (
            <li key={team} className="flex items-center gap-2 py-1">
              <span className="w-6 text-center font-mono font-bold text-primary">{i + 1}</span>
              <span className="truncate">{team}</span>
              {i < 2 && (
                <span className="ml-auto rounded bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase text-secondary-foreground">
                  Bye
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-6">
        {playoffs.rounds.map((round, idx) => {
          const roundNum = round[0]?.round ?? idx + 1;
          const isActive = idx === activeRoundIdx;
          return (
            <section key={roundNum} className="rounded-xl border bg-card">

              <header className="flex items-center justify-between border-b px-4 py-2.5">
                <h3 className="text-sm font-bold uppercase tracking-wide">
                  {PLAYOFF_ROUND_NAMES[roundNum]}
                </h3>
                {isActive && (
                  <span className="rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-bold uppercase text-primary-foreground">
                    In progress
                  </span>
                )}
              </header>
              <ul className="divide-y">
                {round.map((m) => {
                  const winner = matchWinner(m);
                  const manualOnly = isManualOnly(m.home, m.away);
                  const tie = m.result && !winner;
                  return (
                    <li key={m.id} className="px-4 py-2.5 text-sm">
                      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                        <span className={`truncate text-right font-medium ${winner === m.home ? "text-primary" : ""}`}>
                          <span className="mr-1 font-mono text-xs text-muted-foreground">#{m.homeSeed}</span>
                          {m.home}
                        </span>
                        <span className="min-w-[64px] text-center font-mono font-bold tabular-nums">
                          {m.result ? `${m.result.homeGoals} - ${m.result.awayGoals}` : "vs"}
                        </span>
                        <span className={`truncate text-left font-medium ${winner === m.away ? "text-primary" : ""}`}>
                          {m.away}
                          <span className="ml-1 font-mono text-xs text-muted-foreground">#{m.awaySeed}</span>
                        </span>
                      </div>
                      {isActive && !m.result && (
                        <div className="mt-1.5 flex flex-wrap justify-center gap-2">
                          {!manualOnly && (
                            <Button size="sm" variant="secondary" onClick={() => setSimMatch(m)}>
                              SIMULATE
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => setManualMatch(m)}>
                            ENTER MATCH RESULT
                          </Button>
                          {manualOnly && (
                            <span className="self-center text-[10px] uppercase text-muted-foreground">
                              Manual entry only
                            </span>
                          )}
                        </div>
                      )}
                      {tie && (
                        <p className="mt-1 text-center text-[10px] font-semibold uppercase text-destructive">
                          Tie — re-enter a result with a winner to advance
                        </p>
                      )}
                      {m.result?.method === "SIM" && (
                        <div className="mt-1 flex justify-center">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px] font-semibold text-primary"
                            onClick={() => setCommentaryMatch(m)}
                          >
                            VIEW MATCH COMMENTARY
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      {simMatch && (
        <SimulationTerminal
          initialHome={simMatch.home}
          initialAway={simMatch.away}
          lockTeams
          defaultTempoIndex={1}
          fullscreen
          playoff
          onComplete={(h, a, payload) => { setPlayoffResult(simMatch.id, h, a, "SIM", payload); setSimMatch(null); }}
          onExit={() => setSimMatch(null)}
        />
      )}

      <PlayoffManualDialog
        match={manualMatch}
        onClose={() => setManualMatch(null)}
        onSave={(h, a) => {
          if (manualMatch) setPlayoffResult(manualMatch.id, h, a, "MANUAL");
          setManualMatch(null);
        }}
      />

      <MatchCommentaryDialog
        open={!!commentaryMatch}
        onClose={() => setCommentaryMatch(null)}
        title={commentaryMatch ? `${commentaryMatch.home} vs ${commentaryMatch.away}` : ""}
        log={commentaryMatch ? state.payloads[commentaryMatch.id]?.log : undefined}
      />
    </div>
  );
}

function PlayoffManualDialog({
  match, onClose, onSave,
}: {
  match: PlayoffMatch | null;
  onClose: () => void;
  onSave: (h: number, a: number) => void;
}) {
  const [h, setH] = useState("0");
  const [a, setA] = useState("0");
  // Reset the score inputs whenever a different match is opened, so stale scores
  // from a previous entry never carry over.
  useEffect(() => { setH("0"); setA("0"); }, [match?.id]);
  const tie = (parseInt(h) || 0) === (parseInt(a) || 0);
  return (
    <Dialog open={!!match} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Enter Match Result</DialogTitle>
        </DialogHeader>
        {match && (
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
            <div>
              <div className="mb-1 truncate text-xs font-semibold">{match.home}</div>
              <Input type="number" min={0} value={h} onChange={(e) => setH(e.target.value)} className="text-center" />
            </div>
            <span className="pb-2 font-bold text-muted-foreground">-</span>
            <div>
              <div className="mb-1 truncate text-xs font-semibold">{match.away}</div>
              <Input type="number" min={0} value={a} onChange={(e) => setA(e.target.value)} className="text-center" />
            </div>
          </div>
        )}
        {tie && (
          <p className="text-center text-xs text-destructive">
            Playoff games can't end level — one team must win.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={tie}
            onClick={() => onSave(Math.max(0, parseInt(h) || 0), Math.max(0, parseInt(a) || 0))}
          >
            Log Result
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
