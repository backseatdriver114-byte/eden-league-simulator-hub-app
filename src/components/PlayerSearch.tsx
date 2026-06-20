import { useMemo, useState } from "react";
import { reportAiOutcome } from "@/lib/ai-status";
import { useServerFn } from "@tanstack/react-start";
import { useLeague, type LeaguePlayer } from "@/state/league";
import { useNavigation } from "@/state/navigation";
import { parseSearchQuery, playerMatchesQuery } from "@/lib/player-search";
import { interpretSearch } from "@/lib/player-search.functions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const STAT_COLS: { key: keyof LeaguePlayer; label: string }[] = [
  { key: "rating", label: "OVR" },
  { key: "FIN", label: "FIN" }, { key: "SHO", label: "SHO" }, { key: "PAS", label: "PAS" },
  { key: "VIS", label: "VIS" }, { key: "DRI", label: "DRI" }, { key: "PAC", label: "PAC" },
  { key: "STA", label: "STA" }, { key: "DEF", label: "DEF" }, { key: "TAC", label: "TAC" },
  { key: "POS_attr", label: "POS" }, { key: "COM", label: "COM" }, { key: "WR", label: "WR" },
  { key: "AGG", label: "AGG" }, { key: "STR", label: "STR" }, { key: "AER", label: "AER" },
];

const MAX_RESULTS = 40;

export function PlayerSearch() {
  const { state } = useLeague();
  const { goToSuite } = useNavigation();
  const interpret = useServerFn(interpretSearch);

  // `query` is the literal structured query that drives matching. `aiInput` is
  // the natural-language box. When the user runs an AI search we translate the
  // prose into a structured query and run it through the exact same pipeline.
  const [query, setQuery] = useState("");
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiTranslation, setAiTranslation] = useState<string | null>(null);

  const parsed = useMemo(() => parseSearchQuery(query), [query]);

  const results = useMemo(() => {
    if (parsed.isEmpty) return [];
    const hits: { team: string; player: LeaguePlayer }[] = [];
    for (const name of state.teamOrder) {
      const t = state.teams[name];
      if (!t) continue;
      for (const p of t.players) {
        if (playerMatchesQuery(p, parsed)) hits.push({ team: name, player: p });
      }
    }
    return hits.slice(0, MAX_RESULTS);
  }, [parsed, state.teamOrder, state.teams]);

  async function runAiSearch() {
    const prose = aiInput.trim();
    if (!prose || aiLoading) return;
    setAiError(null);
    setAiTranslation(null);
    setAiLoading(true);
    try {
      const res = await interpret({ data: { query: prose } });
      setQuery(res.query);
      setAiTranslation(res.query);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reportAiOutcome(msg);
      if (msg.includes("RATE_LIMIT")) setAiError("The scout is busy — try again in a moment.");
      else if (msg.includes("CREDITS")) setAiError("AI credits exhausted. Add credits in Settings → Workspace → Usage.");
      else setAiError("Couldn't interpret that. Try rephrasing, or use the structured search above.");
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="mb-1 text-base font-extrabold uppercase tracking-wide">Player Search</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Combine as many parameters as you like — position, name, and trait filters all stack (ANDed). Examples:{" "}
        <span className="font-mono">ST, fin &gt; 9, fin &lt; 9.5, pac &gt; 9</span>,{" "}
        <span className="font-mono">RW speed &gt; 8.5</span>,{" "}
        <span className="font-mono">pos:CB STR &gt;= 8 PAC &lt; 6</span>. Friendly words
        (speed, finishing, strength, striker, winger…) and raw codes (PAC, FIN, STR…) both work.
      </p>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="e.g. striker finishing > 8.5 strength > 8"
        className="bg-background"
      />

      {/* Natural-language AI search */}
      <div className="mt-3 rounded-lg border border-dashed bg-background/60 p-3">
        <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          ✨ Ask in plain English
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runAiSearch(); }}
            placeholder='e.g. "find me some fast wingers who also have great stamina"'
            className="bg-background"
          />
          <Button onClick={runAiSearch} disabled={aiLoading || !aiInput.trim()} className="font-semibold">
            {aiLoading ? "Thinking…" : "AI Search"}
          </Button>
        </div>
        {aiTranslation && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Interpreted as: <span className="font-mono text-foreground">{aiTranslation}</span> — edit the box above to refine.
          </p>
        )}
        {aiError && <p className="mt-2 text-[11px] text-destructive">{aiError}</p>}
      </div>

      {!parsed.isEmpty && (
        <div className="mt-3">
          {results.length === 0 ? (
            <p className="text-sm text-muted-foreground">No players match that search.</p>
          ) : (
            <div className="space-y-3">
              {results.map(({ team, player }, i) => (
                <div key={`${team}-${player.name}-${i}`} className="rounded-lg border bg-background p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold">{player.name}</span>{" "}
                      <span className="text-xs text-muted-foreground">{player.position} · {team} · age {player.age}</span>
                      {player.forSale && (
                        <span className="rounded bg-stadium-gold px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-emerald-950">For Sale</span>
                      )}
                      {player.injuryWeeks > 0 && (
                        <span className="rounded bg-destructive px-1.5 py-0.5 text-[9px] font-bold uppercase text-destructive-foreground">Injured</span>
                      )}
                      {player.suspensionWeeks > 0 && (
                        <span className="rounded bg-muted-foreground px-1.5 py-0.5 text-[9px] font-bold uppercase text-background">Susp</span>
                      )}
                    </div>
                    <Button size="sm" variant="outline" onClick={() => goToSuite("Team Editor", { team, player: player.name })}>
                      View in Team Editor
                    </Button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-[11px]">
                      <thead>
                        <tr className="text-muted-foreground">
                          {STAT_COLS.map((c) => <th key={c.label} className="px-1.5 py-0.5 text-center font-semibold">{c.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          {STAT_COLS.map((c) => (
                            <td key={c.label} className={`px-1.5 py-0.5 text-center font-mono tabular-nums ${c.key === "rating" ? "font-bold text-primary" : ""}`}>
                              {Number(player[c.key]).toFixed(1)}
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              {results.length === MAX_RESULTS && (
                <p className="text-center text-[11px] text-muted-foreground">Showing first {MAX_RESULTS} matches — refine your search to narrow it down.</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
