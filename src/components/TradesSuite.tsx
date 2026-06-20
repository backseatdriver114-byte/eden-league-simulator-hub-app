import { useMemo, useState } from "react";
import { reportAiOutcome } from "@/lib/ai-status";
import { useServerFn } from "@tanstack/react-start";
import {
  useLeague, TRANSFER_WINDOW_LAST_WEEK, type LeagueTeam, type DraftPick,
} from "@/state/league";
import {
  calculatePlayerValue, tradeBlockReason, buildTradeMarketBrief,
  buildProposalFromTerms, pickLabel, type TradeProposal,
} from "@/lib/trades";
import { generateAiTradeProposals } from "@/lib/trade-ai.functions";
import { toast } from "sonner";
import { PlayerSearch } from "@/components/PlayerSearch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const TOP_COUNT = 5;


const NONE = "__none__";

export function TradesSuite() {
  const { state, standings, executeTrade, executeManualTrade, declineTrade, setTradeProposals } = useLeague();
  const runAiEngine = useServerFn(generateAiTradeProposals);
  const lastWindowWeek = state.settings?.transferWindowLastWeek ?? TRANSFER_WINDOW_LAST_WEEK;
  const inWindow = state.currentWeek <= lastWindowWeek;
  const [showAll, setShowAll] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  async function runAiTradeEngine() {
    if (aiLoading) return;
    setAiLoading(true);
    try {
      const rankOf = (team: string) => standings.find((s) => s.team === team)?.rank ?? 0;
      const brief = buildTradeMarketBrief(state, [], rankOf);
      const { proposals } = await runAiEngine({ data: { brief, count: 14 } });
      // Re-validate every AI proposal against all safety guards before surfacing.
      const validated: TradeProposal[] = [];
      const seen = new Set<string>();
      proposals.forEach((p, i) => {
        const built = buildProposalFromTerms(
          state, p.teamA, p.teamB, p.aSends, p.bSends, p.cashAReceives, p.cashBReceives, i
        );
        if (!built) return;
        const key = `${built.teamA}|${built.aSends}|${built.teamB}|${built.bSends}`;
        if (seen.has(key)) return;
        seen.add(key);
        validated.push(built);
      });
      validated.sort((a, b) => b.deltaUA + b.deltaUB - (a.deltaUA + a.deltaUB));
      setTradeProposals(validated);
      if (validated.length === 0) {
        toast.warning("No legal deals", { description: "The AI couldn't find any valid trades this round. Try again." });
      } else {
        toast.success("AI trade engine ran", { description: `${validated.length} fresh proposals on the desk.` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reportAiOutcome(msg);
      if (msg.includes("RATE_LIMIT")) toast.error("AI is busy", { description: "Try again in a moment." });
      else if (msg.includes("CREDITS")) toast.error("AI credits exhausted", { description: "Add credits in Settings → Workspace → Usage." });
      else toast.error("Trade engine failed", { description: "Couldn't reach the AI. Please try again." });
    } finally {
      setAiLoading(false);
    }
  }


  // Deals touching a user-controlled (exempt) club are handled in the
  // Negotiation Suite. The automatic desk here shows pure AI-vs-AI deals only.
  const exemptList = state.settings?.contractExemptTeams ?? [];
  const autoProposals = useMemo(
    () =>
      state.tradeProposals.filter(
        (t) =>
          !exemptList.includes(t.teamA) &&
          !exemptList.includes(t.teamB) &&
          // Only show deals that are still legal now — never surface a proposal
          // whose ACCEPT button would be blocked by the cap/budget/roster guards.
          !tradeBlockReason(
            state, t.teamA, t.teamB, [t.aSends], [t.bSends],
            t.cashAReceives, t.cashBReceives, t.aPickIds ?? [], t.bPickIds ?? [],
          ),
      ),
    [state, exemptList.join("|")]
  );


  function acceptProposal(t: TradeProposal) {
    const reason = tradeBlockReason(state, t.teamA, t.teamB, [t.aSends], [t.bSends], t.cashAReceives, t.cashBReceives);
    if (reason) {
      toast.error("Trade blocked", { description: reason });
      return;
    }
    executeTrade(t);
    toast.success("Trade completed", { description: `${t.teamA} ↔ ${t.teamB}` });
  }

  function submitManualTrade(
    teamA: string, teamB: string, aPlayers: string[], bPlayers: string[], cashA: number, cashB: number,
    aPickIds: string[] = [], bPickIds: string[] = [],
  ): boolean {
    const reason = tradeBlockReason(state, teamA, teamB, aPlayers, bPlayers, cashA, cashB);
    if (reason) {
      toast.error("Trade blocked", { description: reason });
      return false;
    }
    executeManualTrade(teamA, teamB, aPlayers, bPlayers, cashA, cashB, aPickIds, bPickIds);
    toast.success("Trade completed", { description: `${teamA} ↔ ${teamB}` });
    return true;
  }

  return (
    <div className="space-y-8">
      {/* AUTOMATIC SECTION */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-extrabold uppercase tracking-wide">Automatic Trade Desk</h2>
            <p className="text-xs text-muted-foreground">
              The AI trade engine reads the entire league — every roster, rating, value, budget and
              cap — and proposes the most realistic deals. The top {TOP_COUNT} are shown first, with
              the option to reveal more.{" "}
              {inWindow ? "Transfer window OPEN." : `Window closed (reopens next season, runs through Week ${lastWindowWeek}).`}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={runAiTradeEngine} disabled={aiLoading}>
            {aiLoading ? "RUNNING AI…" : "RUN AI TRADE ENGINE"}
          </Button>
        </div>


        {autoProposals.length === 0 ? (
          <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
            No proposals available right now. Deals are generated automatically each week, or run the
            engine now. Deals involving your clubs appear in the Negotiation suite.
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {(showAll ? autoProposals : autoProposals.slice(0, TOP_COUNT)).map((t) => (
                <ProposalCard
                  key={t.id}
                  t={t}
                  onAccept={() => acceptProposal(t)}
                  onDecline={() => declineTrade(t.id)}
                />
              ))}
            </div>
            {autoProposals.length > TOP_COUNT && (
              <div className="mt-3 flex justify-center">
                <Button size="sm" variant="outline" onClick={() => setShowAll((v) => !v)} className="font-semibold">
                  {showAll
                    ? "SHOW LESS"
                    : `SHOW MORE (${autoProposals.length - TOP_COUNT} MORE DEALS)`}
                </Button>
              </div>
            )}
          </>
        )}
      </section>


      {/* MANUAL SECTION */}
      <section>
        <h2 className="mb-3 text-base font-extrabold uppercase tracking-wide">Manual Trade Builder</h2>
        <ManualTrade teams={state.teamOrder.map((n) => state.teams[n])} onSubmit={submitManualTrade} />
      </section>

      <PlayerSearch />
    </div>
  );
}

function ProposalCard({
  t, onAccept, onDecline,
}: {
  t: TradeProposal; onAccept: () => void; onDecline: () => void;
}) {
  const { state } = useLeague();
  const labelFor = (ids?: string[]) =>
    (ids ?? []).map((id) => {
      const pk = state.draftPicks.find((p) => p.id === id);
      return pk ? pickLabel(pk) : id;
    });
  const aPickLabels = labelFor(t.aPickIds);
  const bPickLabels = labelFor(t.bPickIds);
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-highlight-blue/40 bg-highlight-blue/5 p-3">
          <div className="text-xs font-bold uppercase tracking-wide text-highlight-blue">{t.teamA}</div>
          <p className="mt-1 text-sm">
            Sends <span className="font-semibold">{t.aSends || "—"}</span>
            {aPickLabels.length > 0 && <span className="font-mono"> + {aPickLabels.join(", ")}</span>}
            {t.cashBReceives > 0 && <> + <span className="font-mono">${t.cashBReceives}M</span></>}
          </p>
        </div>
        <div className="rounded-lg border border-highlight-red/40 bg-highlight-red/5 p-3">
          <div className="text-xs font-bold uppercase tracking-wide text-highlight-red">{t.teamB}</div>
          <p className="mt-1 text-sm">
            Sends <span className="font-semibold">{t.bSends || "—"}</span>
            {bPickLabels.length > 0 && <span className="font-mono"> + {bPickLabels.join(", ")}</span>}
            {t.cashAReceives > 0 && <> + <span className="font-mono">${t.cashAReceives}M</span></>}
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onDecline}>DECLINE</Button>
        <Button size="sm" onClick={onAccept}>ACCEPT</Button>
      </div>
    </div>
  );
}

function ManualTrade({
  teams, onSubmit,
}: {
  teams: LeagueTeam[];
  onSubmit: (teamA: string, teamB: string, aPlayers: string[], bPlayers: string[], cashA: number, cashB: number, aPickIds: string[], bPickIds: string[]) => boolean;
}) {
  const { state } = useLeague();
  const [teamAName, setTeamAName] = useState(teams[0].name);
  const [teamBName, setTeamBName] = useState(teams[1].name);
  const teamA = teams.find((t) => t.name === teamAName) ?? teams[0];
  const teamB = teams.find((t) => t.name === teamBName) ?? teams[1];

  const [aPlayers, setAPlayers] = useState<string[]>([]);
  const [bPlayers, setBPlayers] = useState<string[]>([]);
  const [cashAReceives, setCashAReceives] = useState("0");
  const [cashBReceives, setCashBReceives] = useState("0");
  const [aPicks, setAPicks] = useState<string[]>([]);
  const [bPicks, setBPicks] = useState<string[]>([]);

  const aOwnedPicks = useMemo(() => state.draftPicks.filter((p) => p.owner === teamAName), [state.draftPicks, teamAName]);
  const bOwnedPicks = useMemo(() => state.draftPicks.filter((p) => p.owner === teamBName), [state.draftPicks, teamBName]);
  const validAPicks = useMemo(() => aPicks.filter((id) => aOwnedPicks.some((p) => p.id === id)), [aPicks, aOwnedPicks]);
  const validBPicks = useMemo(() => bPicks.filter((id) => bOwnedPicks.some((p) => p.id === id)), [bPicks, bOwnedPicks]);

  // Reset selections when a club changes so stale names don't linger.
  const aRosterKey = useMemo(() => teamA.players.map((p) => p.name).join("|"), [teamA]);
  const bRosterKey = useMemo(() => teamB.players.map((p) => p.name).join("|"), [teamB]);
  const validA = useMemo(() => aPlayers.filter((n) => teamA.players.some((p) => p.name === n)), [aPlayers, aRosterKey]);
  const validB = useMemo(() => bPlayers.filter((n) => teamB.players.some((p) => p.name === n)), [bPlayers, bRosterKey]);

  const sameTeam = teamAName === teamBName;
  const aValueTotal = validA.reduce((s, n) => s + (calculatePlayerValue(teamA.players.find((p) => p.name === n)!) || 0), 0);
  const bValueTotal = validB.reduce((s, n) => s + (calculatePlayerValue(teamB.players.find((p) => p.name === n)!) || 0), 0);
  const nothing = validA.length === 0 && validB.length === 0 && validAPicks.length === 0 && validBPicks.length === 0;

  function togglePick(side: "a" | "b", id: string) {
    if (side === "a") setAPicks((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
    else setBPicks((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  function submit() {
    if (sameTeam || nothing) return;
    const ok = onSubmit(
      teamAName, teamBName, validA, validB,
      Math.max(0, parseFloat(cashAReceives) || 0),
      Math.max(0, parseFloat(cashBReceives) || 0),
      validAPicks, validBPicks,
    );
    if (!ok) return; // keep the form intact so the deal can be adjusted
    setAPlayers([]); setBPlayers([]); setCashAReceives("0"); setCashBReceives("0"); setAPicks([]); setBPicks([]);
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <TeamPicker label="Team A" value={teamAName} teams={teams} onChange={(v) => { setTeamAName(v); setAPlayers([]); }} />
          <CascadingPlayers label="A sends" team={teamA} value={validA} onChange={setAPlayers} />
          <p className="text-[11px] text-muted-foreground">Total value out: <span className="font-mono">${aValueTotal.toFixed(1)}M</span></p>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cash A receives ($M)</label>
            <Input type="number" min={0} step="0.1" value={cashAReceives} onChange={(e) => setCashAReceives(e.target.value)} className="bg-card" />
          </div>
          <PicksPicker label="A's draft picks" picks={aOwnedPicks} selected={validAPicks} onToggle={(id) => togglePick("a", id)} />
        </div>
        <div className="space-y-2">
          <TeamPicker label="Team B" value={teamBName} teams={teams} onChange={(v) => { setTeamBName(v); setBPlayers([]); }} />
          <CascadingPlayers label="B sends" team={teamB} value={validB} onChange={setBPlayers} />
          <p className="text-[11px] text-muted-foreground">Total value out: <span className="font-mono">${bValueTotal.toFixed(1)}M</span></p>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cash B receives ($M)</label>
            <Input type="number" min={0} step="0.1" value={cashBReceives} onChange={(e) => setCashBReceives(e.target.value)} className="bg-card" />
          </div>
          <PicksPicker label="B's draft picks" picks={bOwnedPicks} selected={validBPicks} onToggle={(id) => togglePick("b", id)} />
        </div>
      </div>
      {sameTeam && <p className="mt-2 text-xs text-destructive">Pick two different clubs.</p>}
      <div className="mt-4 flex justify-end">
        <Button onClick={submit} disabled={sameTeam || nothing} className="px-6 font-semibold">
          INITIATE TRADE
        </Button>
      </div>
    </div>
  );
}

function TeamPicker({
  label, value, teams, onChange,
}: {
  label: string; value: string; teams: LeagueTeam[]; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full bg-card"><SelectValue /></SelectTrigger>
        <SelectContent>
          {teams.map((t) => <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

// Cascading player picker: starts with a single "No player" dropdown. Selecting
// a real player reveals another dropdown (defaulting to "No player") containing
// the remaining roster, and so on.
function CascadingPlayers({
  label, team, value, onChange,
}: {
  label: string; team: LeagueTeam; value: string[]; onChange: (v: string[]) => void;
}) {
  const rows = [...value, ""]; // trailing empty slot for the next pick

  function setAt(i: number, name: string) {
    const next = [...value];
    if (name === "") next.splice(i, 1);
    else next[i] = name;
    onChange(next.filter(Boolean));
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
      <div className="space-y-1.5">
        {rows.map((cur, i) => {
          const taken = new Set(value.filter((_, j) => j !== i));
          const options = team.players.filter((p) => !taken.has(p.name));
          return (
            <Select
              key={i}
              value={cur || NONE}
              onValueChange={(v) => setAt(i, v === NONE ? "" : v)}
            >
              <SelectTrigger className="w-full bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No player</SelectItem>
                {options.map((p) => (
                  <SelectItem key={p.name} value={p.name}>{p.name} ({p.position})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        })}
      </div>
    </div>
  );
}

function PicksPicker({
  label, picks, selected, onToggle,
}: {
  label: string; picks: DraftPick[]; selected: string[]; onToggle: (id: string) => void;
}) {
  if (picks.length === 0) return null;
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {picks.map((pk) => {
          const on = selected.includes(pk.id);
          return (
            <button
              key={pk.id}
              type="button"
              onClick={() => onToggle(pk.id)}
              className={`rounded-md border px-2 py-1 text-[11px] font-mono transition-colors ${on ? "border-primary bg-primary/15 text-foreground" : "bg-card text-muted-foreground hover:border-border"}`}
            >
              {pickLabel(pk)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
