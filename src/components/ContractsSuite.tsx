import { useState } from "react";
import { useLeague, type LeaguePlayer } from "@/state/league";
import { type ContractAction, calculateMarketValue } from "@/lib/contracts";
import { isContractExempt } from "@/lib/engine-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { AgentNegotiationDialog } from "@/components/AgentNegotiationDialog";

const ACTION_TONE: Record<ContractAction["type"], string> = {
  RESIGNED: "text-success",
  NEGOTIATED: "text-success",
  EMERGENCY_SIGN: "text-primary",
  RELEASED: "text-destructive",
  FREE_AGENT: "text-destructive",
};

export function ContractsSuite() {
  const { state, runContractCycle, signFreeAgent, setSalaryCap } = useLeague();
  const [log, setLog] = useState<ContractAction[]>([]);
  const [ran, setRan] = useState(false);
  const [signTo, setSignTo] = useState(state.teamOrder[0]);
  const [capDraft, setCapDraft] = useState("");

  // Agent negotiation state.
  const [negotiating, setNegotiating] = useState<{ team: string; index: number; player: LeaguePlayer } | null>(null);

  const cap = state.salaryCap ?? 0;
  const seasonOver = !!state.playoffs?.champion;
  const freeAgents = state.freeAgents ?? [];
  const userTeams = state.teamOrder.filter(isContractExempt);

  function commitCap() {
    const v = parseFloat(capDraft);
    if (!Number.isNaN(v) && v > 0) setSalaryCap(v);
    setCapDraft("");
  }



  function handleRun() {
    const actions = runContractCycle();
    setLog(actions);
    setRan(true);
  }

  const capEditor = (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Hard Salary Cap</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="font-mono text-2xl font-extrabold text-primary">${cap.toFixed(1)}M</span>
        <Input
          type="number"
          min={1}
          step={1}
          value={capDraft}
          placeholder="edit"
          onChange={(e) => setCapDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commitCap()}
          className="h-8 w-24 text-center font-mono"
        />
        <Button size="sm" variant="secondary" onClick={commitCap} disabled={!capDraft}>
          SET CAP
        </Button>
      </div>
    </div>
  );

  const agentDialog = (
    <AgentNegotiationDialog
      open={!!negotiating}
      team={negotiating?.team ?? ""}
      index={negotiating?.index ?? 0}
      player={negotiating?.player ?? null}
      onClose={() => setNegotiating(null)}
    />
  );

  // Always-visible: contract editor for the user's clubs (item 5 — the only
  // place to change a user-club contract now that the Team Editor locks them).
  const userClubsPanel = userTeams.length === 0 ? null : (
    <div className="space-y-4">
      <div className="rounded-lg border-l-4 border-stadium-gold bg-card px-4 py-2 text-xs text-muted-foreground">
        Your contract talks. Open <span className="font-semibold text-foreground">RENEGOTIATE</span> to
        talk to each player's agent — every agent has their own personality and tolerance.
        These contracts are no longer editable in the Team Editor.
      </div>
      {userTeams.map((team) => {
        const t = state.teams[team];
        if (!t) return null;
        const payroll = t.players.reduce((s, p) => s + (p.salary ?? 0), 0);
        return (
          <div key={team} className="overflow-hidden rounded-xl border border-border bg-card shadow">
            <div className="flex items-center justify-between border-b bg-panel px-3 py-2 text-xs font-bold uppercase tracking-wide">
              <span>{team}</span>
              <span className="font-mono text-muted-foreground">Payroll ${payroll.toFixed(1)}M</span>
            </div>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-1.5 text-left">Player</th>
                  <th className="px-3 py-1.5 text-right">Salary</th>
                  <th className="px-3 py-1.5 text-right">Years</th>
                  <th className="px-3 py-1.5 text-right">Market</th>
                  <th className="px-3 py-1.5 text-right" />
                </tr>
              </thead>
              <tbody>
                {t.players.map((p, i) => (
                  <tr key={`${p.name}-${i}`} className="border-b last:border-0">
                    <td className="px-3 py-1.5 font-medium">
                      {p.name} <span className="text-muted-foreground">({p.position})</span>
                      {p.agent && <span className="ml-2 text-[10px] text-muted-foreground">agent: {p.agent.name}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">${(p.salary ?? 0).toFixed(1)}M</td>
                    <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${(p.contractYears ?? 0) <= 1 ? "text-destructive font-bold" : ""}`}>
                      {p.contractYears ?? 0}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      ${calculateMarketValue(p.rating).toFixed(1)}M
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px] font-semibold"
                        onClick={() => setNegotiating({ team, index: i, player: p })}
                      >
                        RENEGOTIATE
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );

  if (!seasonOver) {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border border-border bg-card/70 p-6 text-center shadow-lg">
          <h2 className="mb-2 text-base font-extrabold uppercase tracking-wide text-primary">Offseason Cycle — Locked</h2>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            The offseason free-agency &amp; auto-renewal cycle opens once a playoff champion is crowned.
            You can still renegotiate your own players below at any time.
          </p>
          <div className="mt-6 flex justify-center">{capEditor}</div>
        </div>
        {userClubsPanel}
        {agentDialog}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card/70 p-4 shadow-lg">
        {capEditor}
        <p className="max-w-xl text-xs text-muted-foreground">
          Run the offseason cycle to decay all contracts by one year, let the AI front offices of the 22
          non-exempt clubs re-sign, negotiate or release expiring players, and emergency-fill any roster
          below 11 from the free-agent pool. Your clubs are handled through agent talks below.
        </p>
        <Button className="ml-auto font-bold" onClick={handleRun}>
          ▶ RUN OFFSEASON CONTRACT CYCLE
        </Button>
      </div>

      {userClubsPanel}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Payroll board */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow">
          <div className="border-b bg-panel px-3 py-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
            Payroll vs Cap
          </div>
          <table className="w-full text-xs">
            <tbody>
              {state.teamOrder.map((name) => {
                const team = state.teams[name];
                const payroll = team.players.reduce((s, p) => s + (p.salary ?? 0), 0);
                const over = payroll > cap + 0.001;
                const expiring = team.players.filter((p) => (p.contractYears ?? 0) === 0).length;
                return (
                  <tr key={name} className="border-b last:border-0">
                    <td className="px-3 py-1.5 font-medium">
                      {name}
                      {isContractExempt(name) && (
                        <span className="ml-1 rounded bg-amber-200 px-1 text-[9px] font-bold uppercase text-amber-900">manual</span>
                      )}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${over ? "text-destructive font-bold" : ""}`}>
                      ${payroll.toFixed(1)}M
                    </td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">
                      {expiring > 0 ? `${expiring} expiring` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Free agents */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow">
          <div className="flex items-center gap-2 border-b bg-panel px-3 py-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
            Free Agent Pool ({freeAgents.length})
            <div className="ml-auto flex items-center gap-1">
              <Select value={signTo} onValueChange={setSignTo}>
                <SelectTrigger className="h-7 w-44 bg-card text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {state.teamOrder.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {freeAgents.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">No unattached players. Run the cycle to release expiring players into free agency.</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {[...freeAgents].sort((a, b) => b.rating - a.rating).map((p) => (
                  <tr key={p.name} className="border-b last:border-0">
                    <td className="px-3 py-1.5 font-medium">{p.name} <span className="text-muted-foreground">({p.position})</span></td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">OVR {p.rating.toFixed(1)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        onClick={() => signFreeAgent(signTo, p.name)}
                        className="text-[11px] font-semibold text-primary hover:underline"
                      >
                        sign → {signTo}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Cycle log */}
      {ran && (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow">
          <div className="border-b bg-panel px-3 py-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
            Offseason Front-Office Report
          </div>
          {log.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">No expiring contracts required action this offseason.</p>
          ) : (
            <ul className="divide-y font-mono text-xs">
              {log.map((a, i) => (
                <li key={i} className="px-3 py-1.5">
                  <span className={`font-bold ${ACTION_TONE[a.type]}`}>{a.type.replace("_", " ")}</span>{" "}
                  <span className="font-semibold">{a.player}</span> · {a.team} — {a.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {agentDialog}
    </div>
  );
}

