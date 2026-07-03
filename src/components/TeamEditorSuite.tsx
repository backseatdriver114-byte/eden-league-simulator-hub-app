import { useEffect, useState } from "react";
import {
  useLeague, ATTR_KEYS, isPlayerOut, SEASON_ENDING_WEEKS,
  buildLineupSlots, isValidFormation, type AttrKey, type LineupSlot,
} from "@/state/league";
import { useNavigation } from "@/state/navigation";
import { isContractExempt } from "@/lib/engine-settings";
import { moraleLabel } from "@/lib/morale";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const NUM_COLS: { key: AttrKey; label: string }[] = [
  { key: "rating", label: "OVR" },
  { key: "FIN", label: "FIN" },
  { key: "SHO", label: "SHO" },
  { key: "PAS", label: "PAS" },
  { key: "VIS", label: "VIS" },
  { key: "DRI", label: "DRI" },
  { key: "PAC", label: "PAC" },
  { key: "STA", label: "STA" },
  { key: "DEF", label: "DEF" },
  { key: "TAC", label: "TAC" },
  { key: "POS_attr", label: "POS" },
  { key: "COM", label: "COM" },
  { key: "WR", label: "WR" },
  { key: "AGG", label: "AGG" },
  { key: "STR", label: "STR" },
  { key: "AER", label: "AER" },
];

// Base tactical identities the simulation engine scores against.
const TACTICAL_STYLES = [
  "Balanced", "Possession", "Counterattack", "Deep Block", "Chaos Attack", "High Press",
] as const;




function weeksLabel(weeks: number): string {
  if (weeks >= SEASON_ENDING_WEEKS) return "Season";
  return `${weeks} wk`;
}

export function TeamEditorSuite() {
  const {
    state, updateBudget, updatePlayer,
    setInjuryWeeks, setSuspensionWeeks, addPlayer, removePlayer, renameTeam,
    setLineupSlot, setFormation, autoFillLineup, setTacticalStyle,
    replaceManager, fireAndHireManager, setPlayerForSale,
  } = useLeague();
  const { consumePayload } = useNavigation();
  const [team, setTeam] = useState(state.teamOrder[0]);

  // Honor a "View in Team Editor" jump from another suite (e.g. Player Search).
  useEffect(() => {
    const payload = consumePayload();
    if (payload?.team && state.teams[payload.team]) setTeam(payload.team);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [nameDraft, setNameDraft] = useState(team);
  const [formationDraft, setFormationDraft] = useState("3-3-2");
  const manager = state.managers?.[team];
  const [mgrNameDraft, setMgrNameDraft] = useState(manager?.name ?? "");
  const [mgrDescDraft, setMgrDescDraft] = useState(manager?.personality ?? "");

  useEffect(() => {
    if (!state.teams[team]) setTeam(state.teamOrder[0]);
  }, [state.teams, state.teamOrder, team]);
  useEffect(() => { setNameDraft(team); }, [team]);
  useEffect(() => {
    if (state.teams[team]) setFormationDraft(state.teams[team].formation);
  }, [team, state.teams]);
  useEffect(() => {
    const m = state.managers?.[team];
    setMgrNameDraft(m?.name ?? "");
    setMgrDescDraft(m?.personality ?? "");
  }, [team, state.managers]);

  const t = state.teams[team];
  if (!t) return null;

  const isUserClub = isContractExempt(team);
  const isUserManager = (manager?.personality ?? "").trim().toUpperCase() === "USER CONTROLLED";
  // User-controlled managers CANNOT have a personality typed in — the AI
  // derives one behind the scenes from their actual behaviour (press quotes,
  // messages). So the textarea is locked to "USER CONTROLLED" for them.
  const mgrDirty =
    mgrNameDraft !== (manager?.name ?? "") ||
    (!isUserManager && mgrDescDraft !== (manager?.personality ?? ""));
  function fireAndHire() {
    const nextName = mgrNameDraft.trim();
    if (!nextName) return;
    const wasName = manager?.name ?? "";
    if (nextName === wasName) return; // no-op — button only fires on a real change
    if (!confirm(
      `FIRE ${wasName || "the current manager"} and HIRE ${nextName}?\n\n` +
      `This is a PUBLIC action. It will:\n` +
      `  • Reset respect to 50 and harshness to 0.5\n` +
      `  • Reset team and player morale to baseline\n` +
      `  • Clear every rival club's relationship rating with ${team}\n` +
      `  • Wipe DM history for ${team}\n` +
      `  • Get talked about in the press and around the league.`
    )) return;
    const personality = isUserManager ? "USER CONTROLLED" : (mgrDescDraft.trim() || (manager?.personality ?? ""));
    fireAndHireManager(team, { name: nextName, personality });
  }

  const payroll = t.players.reduce((s, p) => s + (p.salary ?? 0), 0);
  const slots = buildLineupSlots(t.formation);
  const starterCount = t.lineup.filter((n) => {
    const p = t.players.find((x) => x.name === n);
    return p && !isPlayerOut(p);
  }).length;
  const reserves = t.players
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => isPlayerOut(p));
  const ml = moraleLabel(t.morale);
  const moraleTone =
    ml.tone === "high" ? "text-success" : ml.tone === "low" ? "text-destructive" : "text-foreground";

  function saveName() {
    const next = nameDraft.trim();
    if (next && next !== team && !state.teams[next]) {
      renameTeam(team, next);
      setTeam(next);
    } else {
      setNameDraft(team);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Club
          </label>
          <Select value={team} onValueChange={setTeam}>
            <SelectTrigger className="w-64 bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              {state.teamOrder.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Team Name (rename for promotion/relegation)
          </label>
          <div className="flex gap-2">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              className="h-9 w-56 bg-card"
            />
            <Button size="sm" variant="secondary" onClick={saveName} disabled={nameDraft.trim() === team || !nameDraft.trim()}>
              SAVE NAME
            </Button>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Budget (Liquid Capital)
          </label>
          <input
            value={t.budget}
            onChange={(e) => updateBudget(team, e.target.value)}
            className="h-9 w-40 rounded-md border bg-card px-3 font-mono text-sm font-semibold"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Preferred Tactical Style
          </label>
          <Select value={t.tactical_style} onValueChange={(v) => setTacticalStyle(team, v)}>
            <SelectTrigger className="h-9 w-48 bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TACTICAL_STYLES.map((st) => <SelectItem key={st} value={st}>{st}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-right text-xs text-muted-foreground">

          <div>Team Morale: <span className={`font-semibold ${moraleTone}`}>{t.morale.toFixed(0)}% · {ml.text}</span></div>
          <div>Active starters: <span className={starterCount === slots.length ? "font-semibold text-success" : "font-semibold text-destructive"}>{starterCount}/{slots.length}</span></div>
          <div>Payroll: <span className={`font-semibold ${payroll > (state.salaryCap ?? Infinity) + 0.001 ? "text-destructive" : "text-foreground"}`}>${payroll.toFixed(1)}M / ${(state.salaryCap ?? 0).toFixed(1)}M cap</span></div>
          <div className="text-[10px]">{isUserClub ? "Contracts: negotiated via Contracts suite" : "Contracts: AI-managed (locked)"}</div>
        </div>
      </div>

      {/* Manager slot — kept separate from players */}
      <div className="mb-6 rounded-xl border border-amber-300/60 bg-amber-50/60 p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold uppercase tracking-wide text-amber-900">Manager</h3>
          {isContractExempt(team) && (
            <span className="rounded bg-amber-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900">
              User Controlled
            </span>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Manager Name
            </label>
            <Input
              value={mgrNameDraft}
              onChange={(e) => setMgrNameDraft(e.target.value)}
              placeholder="Manager name"
              className="h-9 bg-card"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Manager Description / Personality
            </label>
            <Textarea
              value={isUserManager ? "USER CONTROLLED" : mgrDescDraft}
              onChange={(e) => setMgrDescDraft(e.target.value)}
              placeholder="Negotiation personality and trading tendencies…"
              className="min-h-[72px] bg-card"
              disabled={isUserManager}
              readOnly={isUserManager}
            />
            {isUserManager && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                User-controlled managers can't type a personality — the AI derives one from your actual press quotes and messages.
              </p>
            )}
          </div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-amber-300/60 bg-card/80 px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Respect Rating</div>
            <div className="text-lg font-bold text-amber-900">
              {typeof manager?.respect === "number" ? manager.respect.toFixed(1) : "50.0"}
              <span className="ml-1 text-xs font-normal text-muted-foreground">/ 100</span>
            </div>
            <p className="text-[10px] text-muted-foreground">How the league press judges this manager. Moves via press conferences & weekly drift.</p>
          </div>
          <div className="rounded-lg border border-amber-300/60 bg-card/80 px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Harshness Rating</div>
            <div className="text-lg font-bold text-amber-900">
              {typeof manager?.harshness === "number" ? manager.harshness.toFixed(2) : "0.50"}
              <span className="ml-1 text-xs font-normal text-muted-foreground">/ 1.00</span>
            </div>
            <p className="text-[10px] text-muted-foreground">0 = sugary, 0.5 = balanced, 1 = scathing. Averaged from press conference tone.</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" variant="secondary" onClick={saveManager} disabled={!mgrDirty || !mgrNameDraft.trim()}>
            SAVE MANAGER
          </Button>
          <p className="text-xs text-muted-foreground">
            Edits the AI manager used by the Negotiation Suite. Kept separate from the player roster below.
          </p>
        </div>
      </div>

      {/* Formation pitch */}

      <div className="mb-6 rounded-xl border border-border bg-card/60 p-4 shadow-lg">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Formation (any rows; digits must total 8 outfielders)
            </label>
            <div className="flex gap-2">
              <Input
                value={formationDraft}
                onChange={(e) => setFormationDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && isValidFormation(formationDraft) && setFormation(team, formationDraft)}
                placeholder="3-3-2"
                className="h-9 w-32 bg-card font-mono"
              />
              <Button size="sm" variant="secondary" disabled={!isValidFormation(formationDraft)} onClick={() => setFormation(team, formationDraft)}>
                APPLY
              </Button>
              <Button size="sm" variant="outline" onClick={() => autoFillLineup(team)}>
                AUTO-FILL
              </Button>
            </div>
            {!isValidFormation(formationDraft) && (
              <p className="mt-1 text-xs text-destructive">Digits must sum to 8 (e.g. 3-3-2, 4-4, 2-3-2-1, 1-2-3-2).</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Any player can be slotted into any position. A simulation requires all 9 slots filled with
            healthy players.
          </p>
        </div>

        <PitchField slots={slots} team={team} t={t} setLineupSlot={setLineupSlot} />
      </div>


      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b bg-panel text-left font-bold uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-2 text-left">PLAYER</th>
              <th className="px-2 py-2 text-center">POS</th>
              <th className="px-1.5 py-2 text-center">AGE</th>
              <th className="px-1.5 py-2 text-center">MOR</th>
              <th className="px-1.5 py-2 text-center">SAL$M</th>
              <th className="px-1.5 py-2 text-center">YRS</th>
              {NUM_COLS.map((c) => <th key={c.key} className="px-1.5 py-2 text-center">{c.label}</th>)}
              <th className="px-2 py-2 text-center">HEALTH</th>
              <th className="px-1.5 py-2 text-center">INJ</th>
              <th className="px-1.5 py-2 text-center">SUS</th>
              <th className="px-2 py-2 text-center" title="List the player for sale to attract buyers">SALE</th>
              <th className="px-2 py-2 text-center" />
            </tr>
          </thead>
          <tbody>
            {t.players.map((p, idx) => {
              const out = isPlayerOut(p);
              return (
                <tr
                  key={idx}
                  className={`border-b last:border-0 ${out ? "bg-destructive/10" : p.starter ? "bg-starter" : ""}`}
                >
                  <td className="px-1 py-1">
                    <input
                      value={p.name}
                      onChange={(e) => updatePlayer(team, idx, { name: e.target.value })}
                      className="w-36 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-border focus:border-ring focus:bg-card focus:outline-none"
                    />
                  </td>
                  <td className="px-1 py-1 text-center">
                    <input
                      value={p.position}
                      onChange={(e) => updatePlayer(team, idx, { position: e.target.value })}
                      className="w-12 rounded border border-transparent bg-transparent px-1 py-0.5 text-center uppercase hover:border-border focus:border-ring focus:bg-card focus:outline-none"
                    />
                  </td>
                  <td className="px-0.5 py-1 text-center">
                    <input
                      type="number"
                      min={15}
                      max={45}
                      value={p.age}
                      onChange={(e) => updatePlayer(team, idx, { age: parseInt(e.target.value) || 0 })}
                      className="w-11 rounded border border-transparent bg-transparent px-1 py-0.5 text-center tabular-nums hover:border-border focus:border-ring focus:bg-card focus:outline-none"
                    />
                  </td>
                  <td className="px-0.5 py-1 text-center">
                    <span className="font-mono tabular-nums text-muted-foreground">{p.morale.toFixed(0)}</span>
                  </td>
                  <td className="px-0.5 py-1 text-center">
                    <span title="Contracts are negotiated in the Contracts suite" className="inline-block w-14 cursor-not-allowed rounded bg-muted px-1 py-0.5 text-center font-mono tabular-nums text-muted-foreground">
                      {(p.salary ?? 0).toFixed(1)}
                    </span>
                  </td>
                  <td className="px-0.5 py-1 text-center">
                    <span title="Contracts are negotiated in the Contracts suite" className="inline-block w-11 cursor-not-allowed rounded bg-muted px-1 py-0.5 text-center font-mono tabular-nums text-muted-foreground">
                      {p.contractYears ?? 0}
                    </span>
                  </td>
                  {NUM_COLS.map((c) =>
                    c.key === "rating" ? (
                      <td key={c.key} className="px-0.5 py-1 text-center">
                        <span
                          title="Auto-calculated weighted average of attributes"
                          className="inline-block w-12 cursor-not-allowed rounded bg-muted px-1 py-0.5 text-center font-mono font-bold tabular-nums text-primary"
                        >
                          {p.rating.toFixed(1)}
                        </span>
                      </td>
                    ) : (
                      <td key={c.key} className="px-0.5 py-1 text-center">
                        <input
                          type="number"
                          step="0.1"
                          value={p[c.key]}
                          onChange={(e) =>
                            updatePlayer(team, idx, { [c.key]: parseFloat(e.target.value) || 0 } as never)
                          }
                          className="w-12 rounded border border-transparent bg-transparent px-1 py-0.5 text-center tabular-nums hover:border-border focus:border-ring focus:bg-card focus:outline-none"
                        />
                      </td>
                    )
                  )}
                  <td className="px-2 py-1 text-center">
                    {p.injuryWeeks > 0 ? (
                      <span className="rounded bg-destructive px-1.5 py-0.5 text-[10px] font-bold uppercase text-destructive-foreground">Injured</span>
                    ) : p.suspensionWeeks > 0 ? (
                      <span className="rounded bg-muted-foreground px-1.5 py-0.5 text-[10px] font-bold uppercase text-background">Susp.</span>
                    ) : (
                      <span className="rounded bg-success px-1.5 py-0.5 text-[10px] font-bold uppercase text-success-foreground">Healthy</span>
                    )}
                  </td>
                  <td className="px-0.5 py-1 text-center">
                    <input
                      type="number"
                      min={0}
                      value={p.injuryWeeks}
                      onChange={(e) => setInjuryWeeks(team, idx, parseInt(e.target.value) || 0)}
                      className="w-12 rounded border border-transparent bg-transparent px-1 py-0.5 text-center tabular-nums hover:border-border focus:border-ring focus:bg-card focus:outline-none"
                    />
                  </td>
                  <td className="px-0.5 py-1 text-center">
                    <input
                      type="number"
                      min={0}
                      value={p.suspensionWeeks}
                      onChange={(e) => setSuspensionWeeks(team, idx, parseInt(e.target.value) || 0)}
                      className="w-12 rounded border border-transparent bg-transparent px-1 py-0.5 text-center tabular-nums hover:border-border focus:border-ring focus:bg-card focus:outline-none"
                    />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <button
                      onClick={() => setPlayerForSale(team, idx, !p.forSale)}
                      className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                        p.forSale
                          ? "border-stadium-gold bg-stadium-gold text-emerald-950"
                          : "border-border bg-card text-muted-foreground hover:border-stadium-gold/60"
                      }`}
                      title={p.forSale ? "Click to take off the market" : "Click to list publicly for sale — attracts more buyers"}
                    >
                      {p.forSale ? "Listed" : "List"}
                    </button>
                  </td>
                  <td className="px-2 py-1 text-center">
                    <button
                      onClick={() => removePlayer(team, idx)}
                      className="text-[11px] font-semibold text-destructive hover:underline"
                    >
                      remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => addPlayer(team)} className="font-semibold">
          + ADD BLANK PLAYER
        </Button>
        <p className="text-xs text-muted-foreground">
          Assign your starting nine via the pitch above. AGE is editable (auto-seeded from a
          physical/mental profile and used by the offseason aging engine). MOR is rolling player
          morale. OVR is auto-calculated from attributes by position.
        </p>
      </div>

      <div className="mt-5 rounded-xl border bg-panel/40 p-4">
        <h3 className="mb-2 text-sm font-bold uppercase tracking-wide">Injured / Suspended Reserve</h3>
        {reserves.length === 0 ? (
          <p className="text-xs text-muted-foreground">No players unavailable — full squad fit.</p>
        ) : (
          <ul className="divide-y">
            {reserves.map(({ p, idx }) => (
              <li key={idx} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="font-medium">
                  {p.name} <span className="text-muted-foreground">({p.position})</span>
                </span>
                <span className="flex gap-3 font-mono text-xs">
                  {p.injuryWeeks > 0 && (
                    <span className="text-destructive">INJURY · {weeksLabel(p.injuryWeeks)} left</span>
                  )}
                  {p.suspensionWeeks > 0 && (
                    <span className="text-muted-foreground">SUSPENSION · {p.suspensionWeeks} wk left</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PitchField({
  slots, team, t, setLineupSlot,
}: {
  slots: LineupSlot[];
  team: string;
  t: { players: { name: string; position: string }[]; lineup: string[] };
  setLineupSlot: (team: string, slot: number, name: string) => void;
}) {
  // Render outfield rows from attack (top) down to defense, GK at the very bottom.
  const lines = Array.from(new Set(slots.map((s) => s.line))).sort((a, b) => b - a);

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-emerald-200/40 p-4 shadow-inner"
      style={{
        background:
          "repeating-linear-gradient(0deg, #1f9d4d 0px, #1f9d4d 36px, #178a43 36px, #178a43 72px)",
      }}
    >
      {/* Pitch markings */}
      <div className="pointer-events-none absolute inset-3 rounded-md border-2 border-white/70" />
      <div className="pointer-events-none absolute left-3 right-3 top-1/2 h-0 -translate-y-1/2 border-t-2 border-white/70" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/70" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" />
      <div className="pointer-events-none absolute left-1/2 top-3 h-12 w-40 -translate-x-1/2 border-2 border-t-0 border-white/70" />
      <div className="pointer-events-none absolute bottom-3 left-1/2 h-12 w-40 -translate-x-1/2 border-2 border-b-0 border-white/70" />

      <div className="relative z-10 flex flex-col gap-4">
        {lines.map((line) => {
          const indices = slots.map((s, i) => ({ s, i })).filter(({ s }) => s.line === line);
          return (
            <div key={line} className="flex flex-wrap justify-center gap-3">
              {indices.map(({ s, i }) => {
                const current = t.lineup[i] ?? "";
                const isGK = s.group === "GK";
                return (
                  <div
                    key={i}
                    className={`w-40 rounded-lg border p-1.5 shadow-md backdrop-blur ${
                      isGK ? "border-amber-300 bg-amber-100/90" : "border-white/60 bg-white/90"
                    }`}
                  >
                    <div className="mb-1 text-center text-[10px] font-bold uppercase tracking-wide text-emerald-900">
                      {isGK ? "GK" : s.label}
                    </div>
                    <Select
                      value={current || "__none__"}
                      onValueChange={(v) => setLineupSlot(team, i, v === "__none__" ? "" : v)}
                    >
                      <SelectTrigger className="h-8 w-full bg-card text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">— empty —</SelectItem>
                        {t.players.map((p) => (
                          <SelectItem key={p.name} value={p.name}>{p.name} ({p.position})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
