import { useEffect, useMemo, useRef, useState } from "react";
import { useLeague, simulateMatch } from "@/state/league";
import { settings } from "@/lib/engine-settings";
import { validateMatchup } from "@/lib/lineup";
import type { MatchPayload } from "@/lib/match-payload";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";

const TEMPO_MAP = [1.0, 1.2, 1.4];
const TEMPO_LABEL = ["Slow", "Normal", "Fast"];
const defaultTempoIdx = () => Math.max(0, TEMPO_MAP.indexOf(settings.defaultTempo));

interface Props {
  initialHome?: string;
  initialAway?: string;
  lockTeams?: boolean;
  defaultTempoIndex?: number;
  onComplete?: (homeGoals: number, awayGoals: number, payload: MatchPayload) => void;
  fullscreen?: boolean;
  onExit?: () => void;
  playoff?: boolean;
}

export function SimulationTerminal({
  initialHome,
  initialAway,
  lockTeams = false,
  defaultTempoIndex,
  onComplete,
  fullscreen = false,
  onExit,
  playoff = false,
}: Props) {
  const { state, addYouthPlayer, setSettings } = useLeague();
  const teams = state.teamOrder;
  const blowoutThreshold = state.settings?.blowoutThreshold ?? settings.blowoutThreshold;
  const blowoutDecay = state.settings?.blowoutDecay ?? settings.blowoutDecay;
  const parityMultiplier = state.settings?.parityMultiplier ?? settings.parityMultiplier;

  const [home, setHome] = useState(initialHome ?? teams[0]);
  const [away, setAway] = useState(initialAway ?? teams[1]);
  const [tempoIdx, setTempoIdx] = useState(defaultTempoIndex ?? defaultTempoIdx());
  const [goalMult, setGoalMult] = useState(settings.goalMultiplier);

  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [score, setScore] = useState<{ h: number; a: number } | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [lines]);

  useEffect(() => () => { if (timerRef.current) window.clearInterval(timerRef.current); }, []);

  const blocked = home === away;

  // Matchday & lineup safety validation runs before a sim can be permitted.
  const validation = useMemo(() => {
    if (blocked) return null;
    const ht = state.teams[home];
    const at = state.teams[away];
    if (!ht || !at) return null;
    return validateMatchup(ht, at);
  }, [state.teams, home, away, blocked]);

  function runSim() {
    if (running || blocked || (validation && !validation.ok)) return;
    setRunning(true);
    setScore(null);
    setLines([]);
    const result = simulateMatch(state, home, away, TEMPO_MAP[tempoIdx], goalMult, playoff);
    const fullLog = result.log;
    let i = 0;
    timerRef.current = window.setInterval(() => {
      // reveal a few lines per tick for a streaming feel
      const step = 2;
      setLines((prev) => fullLog.slice(0, Math.min(prev.length + step, fullLog.length)));
      i += step;
      if (i >= fullLog.length) {
        if (timerRef.current) window.clearInterval(timerRef.current);
        timerRef.current = null;
        setScore({ h: result.homeGoals, a: result.awayGoals });
        setRunning(false);
        onComplete?.(result.homeGoals, result.awayGoals, { ...result.payload, log: fullLog });
      }
    }, 45);
  }

  return (
    <div className={fullscreen ? "fixed inset-0 z-50 overflow-auto bg-background p-4 sm:p-6" : ""}>
      {fullscreen && (
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Full-Screen Simulator
          </span>
          <Button variant="destructive" size="sm" onClick={onExit}>
            EXIT
          </Button>
        </div>
      )}

      {/* Team selectors */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-6">
        <TeamSelect label="Home Team" value={home} teams={teams} onChange={setHome} disabled={lockTeams} />
        <span className="select-none px-1 text-lg font-extrabold tracking-widest text-muted-foreground sm:text-2xl">
          V.S.
        </span>
        <TeamSelect label="Away Team" value={away} teams={teams} onChange={setAway} disabled={lockTeams} />
      </div>
      {blocked && (
        <p className="mt-2 text-center text-sm text-destructive">Home and Away must differ.</p>
      )}

      {/* Lineup safety validation panel */}
      {validation && !validation.ok && (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4">
          <div className="mb-1 text-sm font-bold uppercase tracking-wide text-destructive">
            ⛔ Lineup not match-ready
          </div>
          <ul className="space-y-1 text-xs text-destructive">
            {validation.errors.map((e, i) => <li key={i}>• {e}</li>)}
          </ul>
          {validation.emergency && (
            <div className="mt-3 flex flex-wrap gap-2">
              {[home, away].map((tn) => {
                const t = state.teams[tn];
                const healthy = t.players.filter((p) => p.injuryWeeks === 0 && p.suspensionWeeks === 0).length;
                if (healthy >= 9) return null;
                return (
                  <Button key={tn} size="sm" variant="secondary" onClick={() => addYouthPlayer(tn)}>
                    + YOUTH CALL-UP FOR {tn.toUpperCase()}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Sliders */}
      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between text-sm font-semibold">
            <span>Match Tempo</span>
            <span className="text-primary">{TEMPO_LABEL[tempoIdx]} ({TEMPO_MAP[tempoIdx].toFixed(1)}x)</span>
          </div>
          <Slider min={0} max={2} step={1} value={[tempoIdx]} onValueChange={(v) => setTempoIdx(v[0])} />
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>Slow</span><span>Normal</span><span>Fast</span>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between text-sm font-semibold">
            <span>Goal Multiplier</span>
            <span className="text-primary">{goalMult.toFixed(1)}x</span>
          </div>
          <Slider min={0.1} max={2.0} step={0.1} value={[goalMult]} onValueChange={(v) => setGoalMult(v[0])} />
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>0.1 Defensive</span><span>2.0 Offensive</span>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between text-sm font-semibold">
            <span>Blowout Dampener — steepness ({blowoutThreshold}+ goal lead)</span>
            <span className="text-primary">{blowoutDecay.toFixed(2)}</span>
          </div>
          <Input
            type="number" min={0} step={0.05} defaultValue={blowoutDecay}
            key={`blowout-${blowoutDecay}`}
            onBlur={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) setSettings({ blowoutDecay: Math.max(0, v) });
            }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="h-9 text-center font-mono"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Exponential per-goal suppression. Higher = harsher; 0 = off. Eases back if the trailing side scores.
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between text-sm font-semibold">
            <span>Parity Multiplier (skill-gap)</span>
            <span className="text-primary">{parityMultiplier.toFixed(2)}×</span>
          </div>
          <Input
            type="number" min={0} step={0.05} defaultValue={parityMultiplier}
            key={`parity-${parityMultiplier}`}
            onBlur={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) setSettings({ parityMultiplier: Math.max(0, v) });
            }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="h-9 text-center font-mono"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            1.00× normal. Below 1 compresses skill gaps (more upsets); above 1 widens them (favourites dominate).
          </p>
        </div>
      </div>



      {/* Scoreboard */}
      <div className="mt-6 rounded-xl border bg-panel p-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
          <div className="truncate text-right text-sm font-semibold sm:text-base">{home}</div>
          <div className="rounded-lg bg-card px-5 py-3 text-center shadow-sm">
            <div className="font-mono text-4xl font-extrabold tabular-nums tracking-tight sm:text-5xl">
              {score ? `${score.h} - ${score.a}` : running ? "• • •" : "– : –"}
            </div>
          </div>
          <div className="truncate text-left text-sm font-semibold sm:text-base">{away}</div>
        </div>
        <div className="mt-4 flex justify-center">
          <Button
            onClick={runSim}
            disabled={running || blocked || (validation ? !validation.ok : false)}
            className="px-8 font-semibold"
          >
            {running ? "SIMULATING…" : "RUN MATCH"}
          </Button>
        </div>
      </div>

      {/* Console */}
      <div className="mt-6">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Live Match Commentary
        </div>
        <div
          ref={consoleRef}
          className="h-72 overflow-auto rounded-lg border bg-console-bg p-4 font-mono text-xs leading-relaxed text-console-fg"
        >
          {lines.length === 0 ? (
            <span className="text-muted-foreground">Awaiting kickoff…</span>
          ) : (
            lines.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)
          )}
        </div>
      </div>
    </div>
  );
}

function TeamSelect({
  label, value, teams, onChange, disabled,
}: {
  label: string; value: string; teams: string[]; onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full bg-card">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {teams.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
