import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useLeague, DEFAULT_FORMATION } from "@/state/league";
import { DEFAULT_SALARY_CAP } from "@/lib/contracts";
import { DEFAULT_SETTINGS, type EngineSettings } from "@/lib/engine-settings";
import { listVersions, deleteVersion, type LeagueVersion } from "@/lib/versions";
import { getAiProviderStatus, type ProviderStatus } from "@/lib/ai-status.functions";
import { SaveVersionButton } from "@/components/SaveVersionButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

export function SettingsSuite() {
  const { state, setSalaryCap, setSettings, revertToVersion, resetMorale } = useLeague();
  const s: EngineSettings = state.settings ?? DEFAULT_SETTINGS;

  return (
    <div className="space-y-6">
      <LeagueSettings
        s={s}
        cap={state.salaryCap ?? 0}
        teamOrder={state.teamOrder}
        setSalaryCap={setSalaryCap}
        setSettings={setSettings}
        resetMorale={resetMorale}
      />
      <VersionArchive revertToVersion={revertToVersion} />
    </div>
  );
}

// ---------------- League Settings (all editable) ----------------
function LeagueSettings({
  s, cap, teamOrder, setSalaryCap, setSettings, resetMorale,
}: {
  s: EngineSettings;
  cap: number;
  teamOrder: string[];
  setSalaryCap: (n: number) => void;
  setSettings: (patch: Partial<EngineSettings>) => void;
  resetMorale: () => void;
}) {
  const [capDraft, setCapDraft] = useState("");
  const [confirmResetMorale, setConfirmResetMorale] = useState(false);

  function commitCap() {
    const v = parseFloat(capDraft);
    if (!Number.isNaN(v) && v > 0) setSalaryCap(v);
    setCapDraft("");
  }

  function resetAll() {
    setSettings({ ...DEFAULT_SETTINGS, contractExemptTeams: [...DEFAULT_SETTINGS.contractExemptTeams], manualSimTeams: [...DEFAULT_SETTINGS.manualSimTeams] });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card/70 p-4 shadow-lg">
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-wide text-primary">League Settings</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Every value below is a live tuning knob — the simulation, contract, trade and morale
            engines read these in real time. Changes sync to the Cloud save instantly and are
            covered by UNDO. Structural facts (team count, season length, formation, playoff
            seeding) stay fixed.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={resetAll}>Reset to defaults</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SettingsCard title="Simulation Engine">
          {/* Continuous tempo slider (0.1× – 2.0×). Previously a 3-option
              select (Slow/Normal/Fast); the user asked for full free-form
              control. Any decimal in-range is now allowed. */}
          <div className="rounded-lg border bg-panel/40 p-3">
            <div className="flex items-baseline justify-between">
              <label className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Default tempo</label>
              <span className="font-mono font-bold text-primary">{s.defaultTempo.toFixed(2)}×</span>
            </div>
            <Slider
              value={[s.defaultTempo]}
              min={0.1}
              max={2}
              step={0.05}
              onValueChange={([v]) => setSettings({ defaultTempo: Math.round(v * 100) / 100 })}
              className="mt-2"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Slower = fewer goals & chances per minute. 1.0× is baseline; 2.0× is chaotic end-to-end.
            </p>
          </div>

          <NumberSetting
            label="Goal multiplier (default)" value={s.goalMultiplier} step={0.05} min={0.1} max={2}
            onCommit={(v) => setSettings({ goalMultiplier: v })}
          />
          <NumberSetting
            label="Identity boost weight" value={s.identityBoostWeight} step={0.1} min={0} max={5}
            onCommit={(v) => setSettings({ identityBoostWeight: v })}
          />
          <ToggleSetting
            label="Dynamic tactics (live shifts)" checked={s.dynamicTactics}
            onChange={(v) => setSettings({ dynamicTactics: v })}
          />
          <ToggleSetting
            label="Weather effects" checked={s.weatherEffects}
            onChange={(v) => setSettings({ weatherEffects: v })}
          />
          <ToggleSetting
            label="Playoff penalties (draw → shootout)" checked={s.playoffPenalties}
            onChange={(v) => setSettings({ playoffPenalties: v })}
          />

          <div className="py-2">
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Parity multiplier (skill-gap)</span>
              <span className="font-mono font-bold text-primary">{s.parityMultiplier.toFixed(2)}×</span>
            </div>
            <Slider
              value={[s.parityMultiplier]}
              min={0.5}
              max={2}
              step={0.05}
              onValueChange={([v]) => setSettings({ parityMultiplier: Math.round(v * 100) / 100 })}
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Controls how much raw player attributes matter. <span className="font-semibold text-foreground">1.00×</span> is
              normal. Lower (e.g. 0.50×) shrinks the gap between good and bad teams for tight, upset-prone games; higher
              (1.50–2.00×) exaggerates it so favourites demolish weaker sides.
            </p>
          </div>

          <NumberSetting
            label="Blowout dampener — trigger margin (goals)" value={s.blowoutThreshold} step={1} min={1} max={10}
            onCommit={(v) => setSettings({ blowoutThreshold: Math.round(v) })}
          />
          <NumberSetting
            label="Blowout dampener — steepness (exponential)" value={s.blowoutDecay} step={0.05} min={0}
            onCommit={(v) => setSettings({ blowoutDecay: Math.max(0, v) })}
          />
          <p className="-mt-1 pb-1 text-[11px] text-muted-foreground">
            Once a side leads by the trigger margin ({s.blowoutThreshold}+ goals), scoring is suppressed and the
            penalty grows <span className="font-semibold text-foreground">exponentially</span> with every further goal of
            the lead. The steepness value controls how exponential it is — higher = harsher per-goal suppression, lower =
            gentler, <span className="font-semibold text-foreground">0</span> disables it. The dampener also eases back
            automatically if the trailing team scores and closes the gap. Any value is allowed.
          </p>


          <ExemptSetting
            label="Manual-only clubs (games entered by hand, never simulated)"
            teamOrder={teamOrder} selected={s.manualSimTeams}
            onChange={(list) => setSettings({ manualSimTeams: list })}
          />
        </SettingsCard>

        <SettingsCard title="Contract Engine">
          <Row label="Hard salary cap" value={`$${cap.toFixed(1)}M`} highlight />
          <div className="flex items-center gap-2 py-1.5">
            <Input
              type="number" min={1} step={1} value={capDraft} placeholder="new cap ($M)"
              onChange={(e) => setCapDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commitCap()}
              className="h-8 w-32 text-center font-mono"
            />
            <Button size="sm" variant="secondary" onClick={commitCap} disabled={!capDraft}>SET CAP</Button>
          </div>
          <Row label="Default cap baseline" value={`$${DEFAULT_SALARY_CAP}M`} />
          <NumberSetting
            label="Demand modifier — min" value={s.demandModifierMin} step={0.05} min={0.1} max={s.demandModifierMax}
            onCommit={(v) => setSettings({ demandModifierMin: v })}
          />
          <NumberSetting
            label="Demand modifier — max" value={s.demandModifierMax} step={0.05} min={s.demandModifierMin} max={5}
            onCommit={(v) => setSettings({ demandModifierMax: v })}
          />
          <NumberSetting
            label="Veteran paycut (%)" value={Math.round(s.veteranPaycut * 100)} step={1} min={0} max={90}
            onCommit={(v) => setSettings({ veteranPaycut: Math.max(0, Math.min(0.9, v / 100)) })}
          />
          <ExemptSetting
            teamOrder={teamOrder} selected={s.contractExemptTeams}
            onChange={(list) => setSettings({ contractExemptTeams: list })}
          />
        </SettingsCard>

        <SettingsCard title="Trade Engine">
          <NumberSetting
            label="Utility threshold" value={s.utilityThreshold} step={0.5} min={0} max={50}
            onCommit={(v) => setSettings({ utilityThreshold: v })}
          />
          <NumberSetting
            label="Transfer window — last week" value={s.transferWindowLastWeek} step={1} min={1} max={52}
            onCommit={(v) => setSettings({ transferWindowLastWeek: Math.round(v) })}
          />
          <NumberSetting
            label="Cash utility weight" value={s.cashUtilityWeight} step={0.05} min={0} max={2}
            onCommit={(v) => setSettings({ cashUtilityWeight: v })}
          />
          <NumberSetting
            label="Bench rating weight" value={s.benchRatingWeight} step={0.05} min={0} max={2}
            onCommit={(v) => setSettings({ benchRatingWeight: v })}
          />
        </SettingsCard>

        <SettingsCard title="Morale Engine">
          <NumberSetting
            label="Baseline" value={s.moraleBaseline} step={1} min={0} max={100}
            onCommit={(v) => setSettings({ moraleBaseline: Math.round(v) })}
          />
          <NumberSetting
            label="High band" value={s.highMorale} step={1} min={0} max={100}
            onCommit={(v) => setSettings({ highMorale: Math.round(v) })}
          />
          <NumberSetting
            label="Low band" value={s.lowMorale} step={1} min={0} max={100}
            onCommit={(v) => setSettings({ lowMorale: Math.round(v) })}
          />
          <NumberSetting
            label="Sack threshold (manager respect)" value={s.sackThreshold} step={1} min={0} max={100}
            onCommit={(v) => setSettings({ sackThreshold: Math.round(v) })}
          />
          <NumberSetting
            label="Manager renewal morale" value={s.managerRenewalMorale} step={1} min={0} max={100}
            onCommit={(v) => setSettings({ managerRenewalMorale: Math.round(v) })}
          />
          <NumberSetting
            label="Season carry-over reset" value={s.seasonMoraleReset} step={1} min={0} max={50}
            onCommit={(v) => setSettings({ seasonMoraleReset: Math.round(v) })}
          />

          <div className="py-2">
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Morale volatility</span>
              <span className="font-mono font-bold text-primary">{s.moraleVolatility.toFixed(2)}×</span>
            </div>
            <Slider
              value={[s.moraleVolatility]}
              min={0}
              max={2}
              step={0.05}
              onValueChange={([v]) => setSettings({ moraleVolatility: Math.round(v * 100) / 100 })}
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Scales the size of every morale swing. <span className="font-semibold text-foreground">1.00×</span> is
              the engine default. Lower it (e.g. 0.40×) to make squads far calmer so a beloved manager isn't
              sacked over a short rough patch. Higher makes morale wilder.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <p className="text-[11px] text-muted-foreground">
              Instantly restore <span className="font-semibold text-foreground">every</span> club &amp; player to the
              baseline.
            </p>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirmResetMorale(true)}
              className="font-semibold"
            >
              ⚠ RESET MORALE
            </Button>
          </div>
        </SettingsCard>

        <Dialog open={confirmResetMorale} onOpenChange={setConfirmResetMorale}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>⚠ Reset all morale to {s.moraleBaseline}?</DialogTitle>
              <DialogDescription>
                This sets <span className="font-semibold text-foreground">every team's morale</span> and{" "}
                <span className="font-semibold text-foreground">every player's morale</span> across the entire
                league back to the baseline ({s.moraleBaseline}). It does not undo any sackings that already
                happened. This is a big, league-wide change — you can reverse it with the UNDO button afterwards.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmResetMorale(false)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => { resetMorale(); setConfirmResetMorale(false); }}
              >
                Yes, reset all morale
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>


        <SettingsCard title="Manager & Influence">
          <div className="py-2">
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Press influence baseline</span>
              <span className="font-mono font-bold text-primary">{s.pressInfluenceBaseline.toFixed(2)}×</span>
            </div>
            <Slider value={[s.pressInfluenceBaseline]} min={0} max={3} step={0.05}
              onValueChange={([v]) => setSettings({ pressInfluenceBaseline: Math.round(v * 100) / 100 })} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              How loud a manager's words land. Scales every press-conference + DM morale & relationship swing.
              <span className="font-semibold text-foreground"> 1.00×</span> is the default; respected managers still hit harder than disrespected ones on top of this.
            </p>
          </div>
          <div className="py-2">
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Manager rating volatility</span>
              <span className="font-mono font-bold text-primary">{s.managerRatingVolatility.toFixed(2)}×</span>
            </div>
            <Slider value={[s.managerRatingVolatility]} min={0} max={3} step={0.05}
              onValueChange={([v]) => setSettings({ managerRatingVolatility: Math.round(v * 100) / 100 })} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              How wildly the respect rating swings each week based on standings + harshness extremes.
              This is the SEASONAL/match-results dial — press-conference swings have their own slider below.
            </p>
          </div>
          <div className="py-2">
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Press conference volatility</span>
              <span className="font-mono font-bold text-primary">{(s.pressConferenceVolatility ?? 1).toFixed(2)}×</span>
            </div>
            <Slider value={[s.pressConferenceVolatility ?? 1]} min={0} max={5} step={0.1}
              onValueChange={([v]) => setSettings({ pressConferenceVolatility: Math.round(v * 100) / 100 })} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Dedicated multiplier for respect movement caused by press-conference answers ONLY.
              Crank this up for high-drama interviews without changing weekly match drift.
            </p>
          </div>
          <div className="py-2">
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Standings weight (respect drift)</span>
              <span className="font-mono font-bold text-primary">{(s.standingsWeight ?? 1).toFixed(2)}×</span>
            </div>
            <Slider value={[s.standingsWeight ?? 1]} min={0.5} max={4} step={0.1}
              onValueChange={([v]) => setSettings({ standingsWeight: Math.round(v * 100) / 100 })} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              How much league position pulls a manager's respect each week. Higher = the top of the table earns
              much more respect than the bottom.
            </p>
          </div>
          <NumberSetting label="Relations baseline" value={s.relationsBaseline} step={1} min={0} max={100}
            onCommit={(v) => setSettings({ relationsBaseline: Math.round(v) })} />
          <div className="py-2">
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Relations volatility</span>
              <span className="font-mono font-bold text-primary">{s.relationsVolatility.toFixed(2)}×</span>
            </div>
            <Slider value={[s.relationsVolatility]} min={0} max={3} step={0.05}
              onValueChange={([v]) => setSettings({ relationsVolatility: Math.round(v * 100) / 100 })} />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              How quickly managers warm up or cool off after each interaction. Hot-headed personalities swing harder on top of this.
            </p>
          </div>
        </SettingsCard>

        <SettingsCard title="League Structure (reference)">
          <Row label="Teams" value="24 · 9v9" />
          <Row label="Default formation" value={DEFAULT_FORMATION} />
          <Row label="Regular season" value="12 weeks" />
          <Row label="Final Four" value="Weeks 13–16 (48 games)" />
          <Row label="Playoffs" value="Top 14 seeded, byes for seeds 1–2" />
        </SettingsCard>
      </div>
    </div>
  );
}

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow">
      <div className="border-b bg-panel px-4 py-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="divide-y px-4">{children}</div>
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right font-medium ${highlight ? "font-mono font-extrabold text-primary" : ""}`}>{value}</span>
    </div>
  );
}

// Numeric setting with a local draft committed on blur/Enter.
function NumberSetting({
  label, value, step, min, max, onCommit,
}: {
  label: string; value: number; step?: number; min?: number; max?: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string>(String(value));
  const [editing, setEditing] = useState(false);

  // Keep the field in sync when the underlying value changes externally.
  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);

  function commit() {
    setEditing(false);
    let v = parseFloat(draft);
    if (!Number.isNaN(v)) {
      // Clamp to the field's declared bounds so invalid values (e.g. morale 200,
      // or an inverted demand min/max) can never be committed.
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      onCommit(v);
      setDraft(String(v));
    } else {
      setDraft(String(value));
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type="number" step={step} min={min} max={max} value={draft}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="h-8 w-24 text-center font-mono"
      />
    </div>
  );
}

function ToggleSetting({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SelectSetting({
  label, value, options, onChange,
}: {
  label: string; value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

// Multi-select for contract-exempt clubs.
function ExemptSetting({
  teamOrder, selected, onChange, label = "Exempt clubs (auto contract engine skips these)",
}: { teamOrder: string[]; selected: string[]; onChange: (list: string[]) => void; label?: string }) {
  function toggle(name: string) {
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  }
  return (
    <div className="py-2 text-sm">
      <div className="mb-1.5 text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {teamOrder.map((name) => {
          const on = selected.includes(name);
          return (
            <button
              key={name} type="button" onClick={() => toggle(name)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:border-primary/50"
              }`}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- Version Archive ----------------
function VersionArchive({ revertToVersion }: { revertToVersion: (data: LeagueVersion["data"]) => void }) {
  const [versions, setVersions] = useState<LeagueVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = useState<LeagueVersion | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setVersions(await listVersions());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load versions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handleDelete(id: string) {
    try {
      await deleteVersion(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete version.");
    }
  }

  function doRevert() {
    if (!confirmRevert) return;
    revertToVersion(confirmRevert.data);
    setConfirmRevert(null);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-panel px-4 py-2.5">
        <div className="text-sm font-bold uppercase tracking-wide">Save Version Archive</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>↻ Refresh</Button>
          <SaveVersionButton variant="secondary" onSaved={refresh} />
        </div>
      </div>

      <div className="px-4 py-2 text-xs text-muted-foreground">
        Restore points for all league data except Team Editor rosters/budgets/lineups. Use these to
        recover if the live Cloud save ever glitches.
      </div>

      {error && <div className="px-4 py-2 text-xs text-destructive">{error}</div>}

      {loading ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading saved versions…</div>
      ) : versions.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No saved versions yet. Click <span className="font-semibold text-foreground">Save Version</span> to create one.
        </div>
      ) : (
        <ul className="divide-y">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <div>
                <div className="font-semibold">{v.title}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(v.created_at).toLocaleString()} · Season {v.data?.season ?? "?"} · Week {v.data?.currentWeek ?? "?"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setConfirmRevert(v)}>REVERT TO THIS</Button>
                <Button
                  size="sm" variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleDelete(v.id)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!confirmRevert} onOpenChange={(o) => !o && setConfirmRevert(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Revert to this version?</DialogTitle>
            <DialogDescription>
              This replaces the current schedule, results, match commentary, playoffs, trades and
              contract settings with <span className="font-semibold text-foreground">{confirmRevert?.title}</span>.
              Your Team Editor data (rosters, budgets, lineups) will be kept as-is. You can undo this
              with the UNDO button afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRevert(null)}>Cancel</Button>
            <Button variant="destructive" onClick={doRevert}>Revert league data</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
