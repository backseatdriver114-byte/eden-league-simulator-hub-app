import { useMemo, useState } from "react";
import { reportAiOutcome } from "@/lib/ai-status";
import { useServerFn } from "@tanstack/react-start";
import {
  useLeague, prospectPlayer, DRAFT_POOL_SIZE, type LeaguePlayer,
} from "@/state/league";
import { useNavigation, type NegotiationSeedPayload } from "@/state/navigation";
import { computeOverall } from "@/lib/ratings";
import {
  buildTradeMarketBrief, buildAiPickProposal, pickLabel, type TradeProposal,
} from "@/lib/trades";
import { generateAiTradeProposals } from "@/lib/trade-ai.functions";
import { generateProspectRatings, aiDraftPick } from "@/lib/draft-ai.functions";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const ATTR_COLS: { key: keyof LeaguePlayer; label: string }[] = [
  { key: "FIN", label: "FIN" }, { key: "SHO", label: "SHO" }, { key: "PAS", label: "PAS" },
  { key: "VIS", label: "VIS" }, { key: "DRI", label: "DRI" }, { key: "PAC", label: "PAC" },
  { key: "STA", label: "STA" }, { key: "DEF", label: "DEF" }, { key: "TAC", label: "TAC" },
  { key: "POS_attr", label: "POS" }, { key: "COM", label: "COM" }, { key: "WR", label: "WR" },
  { key: "AGG", label: "AGG" }, { key: "STR", label: "STR" }, { key: "AER", label: "AER" },
];

const POSITIONS = [
  "GK", "CB", "LB", "RB", "LWB", "RWB", "CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "ST",
];

export function DraftSuite() {
  const { state } = useLeague();
  const champion = state.playoffs?.champion;
  const draft = state.draft;

  // The Draft Suite is an offseason tool — locked until the season concludes
  // (a playoff champion has been crowned).
  if (!champion) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center">
        <h2 className="text-lg font-extrabold uppercase tracking-wide">Eden League Draft — Locked</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          The draft opens in the offseason. Finish the regular season and crown a playoff champion in
          the <span className="font-semibold text-foreground">Playoffs</span> suite to unlock the draft pool.
        </p>
      </div>
    );
  }

  if (draft?.started) {
    return <DraftBoard />;
  }
  return <DraftPool />;
}

// ---------------- Stage 1: prospect pool + creation ----------------
function DraftPool() {
  const { state, setDraftProspects, startDraft } = useLeague();
  const prospects = state.draft?.prospects ?? [];
  const [sortBy, setSortBy] = useState<"ovr" | "position" | "name">("ovr");
  const [creating, setCreating] = useState(false);

  const sorted = useMemo(() => {
    const copy = [...prospects];
    if (sortBy === "ovr") copy.sort((a, b) => b.rating - a.rating);
    else if (sortBy === "name") copy.sort((a, b) => a.name.localeCompare(b.name));
    else copy.sort((a, b) => a.position.localeCompare(b.position) || b.rating - a.rating);
    return copy;
  }, [prospects, sortBy]);

  if (creating) {
    return (
      <ProspectCreator
        onCancel={() => setCreating(false)}
        onAdd={(p) => { setDraftProspects([...prospects, p]); setCreating(false); }}
      />
    );
  }

  const ready = prospects.length >= DRAFT_POOL_SIZE;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button onClick={() => setCreating(true)} className="font-semibold">CREATE NEW PROSPECT PLAYER</Button>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sort by</span>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
            <SelectTrigger className="w-36 bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ovr">Overall (high→low)</SelectItem>
              <SelectItem value="position">Position</SelectItem>
              <SelectItem value="name">Name</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border-l-4 border-stadium-gold bg-card px-4 py-2 text-xs text-muted-foreground">
        Prospect pool: <span className="font-semibold text-foreground">{prospects.length}/{DRAFT_POOL_SIZE}</span>.
        {" "}Create {Math.max(0, DRAFT_POOL_SIZE - prospects.length)} more to begin the 2-round, 48-pick draft.
      </div>

      {prospects.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          No prospects yet. Hit <span className="font-semibold">CREATE NEW PROSPECT PLAYER</span> to build the draft class.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b bg-panel text-left font-bold uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-2">PROSPECT</th>
                <th className="px-2 py-2 text-center">POS</th>
                <th className="px-2 py-2 text-center">OVR</th>
                {ATTR_COLS.map((c) => <th key={c.label} className="px-1.5 py-2 text-center">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => (
                <tr key={`${p.name}-${i}`} className="border-b last:border-0">
                  <td className="px-2 py-1 font-semibold">{p.name}</td>
                  <td className="px-2 py-1 text-center">{p.position}</td>
                  <td className="px-2 py-1 text-center font-mono font-bold text-primary">{p.rating.toFixed(1)}</td>
                  {ATTR_COLS.map((c) => (
                    <td key={c.label} className="px-1.5 py-1 text-center font-mono tabular-nums">{Number(p[c.key]).toFixed(1)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ready && (
        <div className="flex justify-center">
          <Button size="lg" onClick={startDraft} className="font-extrabold">START EDEN LEAGUE DRAFT</Button>
        </div>
      )}
    </div>
  );
}

function ProspectCreator({ onCancel, onAdd }: { onCancel: () => void; onAdd: (p: LeaguePlayer) => void }) {
  const genRatings = useServerFn(generateProspectRatings);
  const [name, setName] = useState("NEW PROSPECT PLAYER");
  const [position, setPosition] = useState("CM");
  const [overall, setOverall] = useState("6.5");
  const [loading, setLoading] = useState(false);
  const [slot, setSlot] = useState<LeaguePlayer | null>(null);

  async function generate() {
    const ovr = parseFloat(overall);
    if (!name.trim() || !position.trim() || !Number.isFinite(ovr)) {
      toast.error("Fill in name, position, and overall first.");
      return;
    }
    setLoading(true);
    try {
      const { attributes } = await genRatings({ data: { name: name.trim(), position: position.trim().toUpperCase(), overall: ovr } });
      const base = prospectPlayer();
      const built: LeaguePlayer = {
        ...base,
        name: name.trim(),
        position: position.trim().toUpperCase(),
        ...attributes,
      };
      setSlot({ ...built, rating: computeOverall(built) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reportAiOutcome(msg);
      if (msg.includes("RATE_LIMIT")) toast.error("AI is busy", { description: "Try again in a moment." });
      else if (msg.includes("CREDITS")) toast.error("AI credits exhausted", { description: "Add credits in Settings → Workspace → Usage." });
      else toast.error("Couldn't generate ratings", { description: "Please try again." });
    } finally {
      setLoading(false);
    }
  }

  function patch(key: keyof LeaguePlayer, value: number) {
    setSlot((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: value } as LeaguePlayer;
      return { ...next, rating: computeOverall(next) };
    });
  }

  return (
    <div className="space-y-5">
      <Button size="sm" variant="outline" onClick={onCancel}>← Back to pool</Button>

      {!slot ? (
        <div className="rounded-xl border bg-card p-5">
          <h2 className="mb-4 text-base font-extrabold uppercase tracking-wide">New Prospect</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Player Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-background" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Position</label>
              <Select value={position} onValueChange={setPosition}>
                <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>{POSITIONS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overall Rating (1–10)</label>
              <Input type="number" min={1} max={10} step="0.1" value={overall} onChange={(e) => setOverall(e.target.value)} className="bg-background" />
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            AI will craft this prospect's individual attributes from the name, position, and overall — then you can fine-tune them.
          </p>
          <div className="mt-4 flex justify-end">
            <Button onClick={generate} disabled={loading} className="font-semibold">
              {loading ? "GENERATING…" : "GENERATE RATINGS"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-5">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</label>
              <Input value={slot.name} onChange={(e) => setSlot({ ...slot, name: e.target.value })} className="w-56 bg-background" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Position</label>
              <Select value={slot.position} onValueChange={(v) => setSlot({ ...slot, position: v })}>
                <SelectTrigger className="w-28 bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>{POSITIONS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Overall</div>
              <div className="text-2xl font-extrabold text-primary">{slot.rating.toFixed(1)}</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {ATTR_COLS.map((c) => (
              <div key={c.label}>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{c.label}</label>
                <Input
                  type="number" min={1} max={10} step="0.1"
                  value={Number(slot[c.key])}
                  onChange={(e) => patch(c.key, parseFloat(e.target.value) || 0)}
                  className="bg-background text-center font-mono"
                />
              </div>
            ))}
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">Rookie contract is fixed at $2M / 2 years when drafted.</p>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSlot(null)}>← Re-generate</Button>
            <Button onClick={() => onAdd(slot)} className="font-semibold">ADD PROSPECT PLAYER TO DRAFT POOL</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Stage 2: the draft board ----------------
function DraftBoard() {
  const {
    state, standings, selectProspect, executeTrade, executeManualTrade, resetDraft,
  } = useLeague();
  const { goToSuite } = useNavigation();
  const runEngine = useServerFn(generateAiTradeProposals);
  const runAiPick = useServerFn(aiDraftPick);

  const draft = state.draft!;
  const exemptList = state.settings?.contractExemptTeams ?? [];
  const isUser = (n: string) => exemptList.includes(n);

  const [proposals, setProposals] = useState<TradeProposal[]>([]);
  const [scanning, setScanning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [manualProspect, setManualProspect] = useState("");

  const pickIdToPick = useMemo(() => {
    const m = new Map(state.draftPicks.map((pk) => [pk.id, pk] as const));
    return m;
  }, [state.draftPicks]);

  if (draft.complete) {
    return (
      <div className="space-y-5">
        <div className="rounded-xl border bg-card p-8 text-center">
          <h2 className="text-lg font-extrabold uppercase tracking-wide">Draft Complete</h2>
          <p className="mt-2 text-sm text-muted-foreground">All {draft.order.length} picks have been made. Rookies have joined their clubs on $2M / 2yr deals.</p>
        </div>
        <DraftResults draft={draft} pickIdToPick={pickIdToPick} />
        <div className="flex justify-center">
          <Button variant="outline" onClick={resetDraft}>Clear draft board</Button>
        </div>
      </div>
    );
  }

  const currentPickId = draft.order[draft.currentPickIndex];
  const currentPick = pickIdToPick.get(currentPickId);
  const owner = currentPick?.owner ?? "";
  const ownerIsUser = isUser(owner);
  const available = draft.prospects;

  const roundOf = (i: number) => (i < state.teamOrder.length ? 1 : 2);
  const slotOf = (i: number) => (i % state.teamOrder.length) + 1;

  async function scanTrades() {
    if (scanning) return;
    setScanning(true);
    try {
      const rankOf = (team: string) => standings.find((s) => s.team === team)?.rank ?? 0;
      const brief = buildTradeMarketBrief(state, [], rankOf);
      const { proposals: raw } = await runEngine({ data: { brief, count: 10, allowPicks: true } });
      const validated: TradeProposal[] = [];
      const seen = new Set<string>();
      raw.forEach((p, i) => {
        const built = buildAiPickProposal(
          state, p.teamA, p.teamB, p.aSends, p.bSends,
          p.aPicks ?? [], p.bPicks ?? [], p.cashAReceives, p.cashBReceives, i
        );
        if (!built) return;
        const key = `${built.teamA}|${built.aSends}|${(built.aPickIds ?? []).join(",")}|${built.teamB}|${built.bSends}|${(built.bPickIds ?? []).join(",")}`;
        if (seen.has(key)) return;
        seen.add(key);
        validated.push(built);
      });
      // Quality over quantity — only the best handful.
      validated.sort((a, b) => b.deltaUA + b.deltaUB - (a.deltaUA + a.deltaUB));
      setProposals(validated.slice(0, 5));
      if (validated.length === 0) toast.info("No strong trades", { description: "Nothing worth proposing this pick." });
      else toast.success("Trade scan complete", { description: `${Math.min(validated.length, 5)} proposal(s).` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reportAiOutcome(msg);
      if (msg.includes("RATE_LIMIT")) toast.error("AI is busy", { description: "Try again in a moment." });
      else if (msg.includes("CREDITS")) toast.error("AI credits exhausted", { description: "Add credits in Settings → Workspace → Usage." });
      else toast.error("Trade scan failed", { description: "Please try again." });
    } finally {
      setScanning(false);
    }
  }

  function acceptProposal(p: TradeProposal) {
    executeTrade(p);
    setProposals((list) => list.filter((x) => x.id !== p.id));
    toast.success("Trade completed", { description: `${p.teamA} ↔ ${p.teamB}` });
  }

  function declineProposal(p: TradeProposal) {
    setProposals((list) => list.filter((x) => x.id !== p.id));
  }

  function negotiateProposal(p: TradeProposal) {
    const userTeam = isUser(p.teamA) ? p.teamA : p.teamB;
    const aiTeam = userTeam === p.teamA ? p.teamB : p.teamA;
    const seed: NegotiationSeedPayload =
      userTeam === p.teamA
        ? {
            proposalId: p.id, userTeam, aiTeam,
            userSends: p.aSends ? [p.aSends] : [], aiSends: p.bSends ? [p.bSends] : [],
            cashUserReceives: p.cashAReceives, cashAiReceives: p.cashBReceives,
            userPicks: p.aPickIds ?? [], aiPicks: p.bPickIds ?? [],
          }
        : {
            proposalId: p.id, userTeam, aiTeam,
            userSends: p.bSends ? [p.bSends] : [], aiSends: p.aSends ? [p.aSends] : [],
            cashUserReceives: p.cashBReceives, cashAiReceives: p.cashAReceives,
            userPicks: p.bPickIds ?? [], aiPicks: p.aPickIds ?? [],
          };
    setProposals((list) => list.filter((x) => x.id !== p.id));
    goToSuite("Negotiation", { negotiationSeed: seed, returnSuite: "Draft" });
  }

  async function simulateAiPick() {
    if (picking || !currentPick) return;
    setPicking(true);
    try {
      const team = state.teams[owner];
      const rosterLines = team
        ? team.players.map((pl) => `  - ${pl.name} (${pl.position}, OVR ${pl.rating.toFixed(1)})`).join("\n")
        : "(unknown roster)";
      const prospectLines = available
        .map((pr) => `  - ${pr.name} (${pr.position}, OVR ${pr.rating.toFixed(1)})`)
        .join("\n");
      const brief = [
        `${owner} current roster:`, rosterLines, ``, `Available prospects:`, prospectLines,
      ].join("\n");
      const { pick } = await runAiPick({ data: { team: owner, brief, prospectNames: available.map((p) => p.name) } });
      selectProspect(currentPickId, pick);
      toast.success(`${owner} selects ${pick}`);
      setProposals([]);
    } catch {
      // Fallback: take the highest-rated available prospect so the draft never stalls.
      const best = [...available].sort((a, b) => b.rating - a.rating)[0];
      if (best) { selectProspect(currentPickId, best.name); toast.success(`${owner} selects ${best.name}`); }
      else toast.error("No prospects left to pick.");
      setProposals([]);
    } finally {
      setPicking(false);
    }
  }

  function makeUserPick() {
    if (!manualProspect) { toast.error("Choose a prospect first."); return; }
    selectProspect(currentPickId, manualProspect);
    toast.success(`${owner} selects ${manualProspect}`);
    setManualProspect("");
    setProposals([]);
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-extrabold uppercase tracking-wide">
              Pick #{draft.currentPickIndex + 1} — Round {roundOf(draft.currentPickIndex)}, Slot {slotOf(draft.currentPickIndex)}
            </h2>
            <p className="text-xs text-muted-foreground">
              On the clock: <span className="font-bold text-foreground">{owner}</span>
              {currentPick && currentPick.originalTeam !== owner && (
                <> (via {currentPick.originalTeam}, acquired by trade)</>
              )}
              {ownerIsUser && <span className="ml-1 font-semibold text-stadium-gold">· Your pick</span>}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={scanTrades} disabled={scanning}>
            {scanning ? "SCANNING…" : "SCAN FOR TRADES"}
          </Button>
        </div>

        {proposals.length > 0 && (
          <div className="mt-4 space-y-3">
            <h3 className="text-xs font-extrabold uppercase tracking-wide text-muted-foreground">Trade Proposals</h3>
            {proposals.map((p) => {
              const involvesUser = isUser(p.teamA) || isUser(p.teamB);
              return (
                <div key={p.id} className="rounded-lg border bg-background p-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <DealSide team={p.teamA} player={p.aSends} cash={p.cashBReceives} pickIds={p.aPickIds ?? []} pickIdToPick={pickIdToPick} />
                    <DealSide team={p.teamB} player={p.bSends} cash={p.cashAReceives} pickIds={p.bPickIds ?? []} pickIdToPick={pickIdToPick} />
                  </div>
                  <div className="mt-2 flex justify-end gap-2">
                    {involvesUser ? (
                      <Button size="sm" onClick={() => negotiateProposal(p)}>NEGOTIATE</Button>
                    ) : (
                      <>
                        <Button size="sm" variant="outline" onClick={() => declineProposal(p)}>DECLINE</Button>
                        <Button size="sm" onClick={() => acceptProposal(p)}>ACCEPT</Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4 border-t pt-4">
          {ownerIsUser ? (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Select a prospect</label>
                <Select value={manualProspect} onValueChange={setManualProspect}>
                  <SelectTrigger className="w-72 bg-background"><SelectValue placeholder="Choose prospect…" /></SelectTrigger>
                  <SelectContent>
                    {[...available].sort((a, b) => b.rating - a.rating).map((p) => (
                      <SelectItem key={p.name} value={p.name}>{p.name} — {p.position}, OVR {p.rating.toFixed(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={makeUserPick} className="font-semibold">DRAFT PLAYER</Button>
            </div>
          ) : (
            <Button onClick={simulateAiPick} disabled={picking} className="font-semibold">
              {picking ? "SELECTING…" : "SIMULATE PICK"}
            </Button>
          )}
        </div>
      </div>

      {/* Board overview */}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b bg-panel text-left font-bold uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">R</th>
              <th className="px-2 py-2">OWNER</th>
              <th className="px-2 py-2">ORIGINAL</th>
              <th className="px-2 py-2">SELECTION</th>
            </tr>
          </thead>
          <tbody>
            {draft.order.map((pid, i) => {
              const pk = pickIdToPick.get(pid);
              const sel = draft.selections.find((s) => s.pickId === pid);
              const isCurrent = i === draft.currentPickIndex;
              return (
                <tr key={pid} className={`border-b last:border-0 ${isCurrent ? "bg-stadium-gold/15" : ""}`}>
                  <td className="px-2 py-1 font-mono">{i + 1}</td>
                  <td className="px-2 py-1">{roundOf(i)}</td>
                  <td className="px-2 py-1 font-semibold">{pk?.owner ?? "—"}{pk && isUser(pk.owner) && <span className="ml-1 text-[10px] text-stadium-gold">●</span>}</td>
                  <td className="px-2 py-1 text-muted-foreground">{pk?.originalTeam ?? "—"}</td>
                  <td className="px-2 py-1">{sel ? <span className="font-semibold">{sel.prospectName}</span> : isCurrent ? <span className="italic text-muted-foreground">on the clock…</span> : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DealSide({
  team, player, cash, pickIds, pickIdToPick,
}: {
  team: string; player: string; cash: number; pickIds: string[];
  pickIdToPick: Map<string, import("@/state/league").DraftPick>;
}) {
  const labels = pickIds.map((id) => { const p = pickIdToPick.get(id); return p ? pickLabel(p) : id; });
  return (
    <div className="rounded-md border bg-card p-2">
      <div className="text-xs font-bold uppercase tracking-wide">{team} sends</div>
      <p className="mt-1 text-sm">
        {player || <span className="text-muted-foreground">—</span>}
        {labels.length > 0 && <span className="font-mono"> {labels.join(", ")}</span>}
        {cash > 0 && <span className="font-mono"> + ${cash}M</span>}
      </p>
    </div>
  );
}

function DraftResults({
  draft, pickIdToPick,
}: {
  draft: NonNullable<ReturnType<typeof useLeague>["state"]["draft"]>;
  pickIdToPick: Map<string, import("@/state/league").DraftPick>;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b bg-panel text-left font-bold uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-2">#</th>
            <th className="px-2 py-2">TEAM</th>
            <th className="px-2 py-2">SELECTION</th>
          </tr>
        </thead>
        <tbody>
          {draft.order.map((pid, i) => {
            const sel = draft.selections.find((s) => s.pickId === pid);
            const pk = pickIdToPick.get(pid);
            return (
              <tr key={pid} className="border-b last:border-0">
                <td className="px-2 py-1 font-mono">{i + 1}</td>
                <td className="px-2 py-1 font-semibold">{sel?.team ?? pk?.owner ?? "—"}</td>
                <td className="px-2 py-1">{sel?.prospectName ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
