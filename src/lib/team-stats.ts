// Team-level derived stats from raw match results — no engine coupling.
// Used by the standings table, Trophy Room, and news auto-gen to show form
// pills, current streaks, and GD tints.
import type { LeagueState } from "@/state/league";

export type FormResult = "W" | "D" | "L";

// Chronological list of results for a team (oldest → newest), across regular
// season and playoffs. `week` is used only for ordering.
export function teamResultsChrono(state: LeagueState, team: string): FormResult[] {
  const rows: { week: number; res: FormResult }[] = [];
  for (const fx of state.fixtures) {
    const r = state.results[fx.id];
    if (!r) continue;
    if (fx.home !== team && fx.away !== team) continue;
    const iAmHome = fx.home === team;
    const my = iAmHome ? r.homeGoals : r.awayGoals;
    const opp = iAmHome ? r.awayGoals : r.homeGoals;
    rows.push({ week: fx.week, res: my > opp ? "W" : my < opp ? "L" : "D" });
  }
  rows.sort((a, b) => a.week - b.week);
  return rows.map((r) => r.res);
}

// Last 5 results (newest last).
export function lastFive(state: LeagueState, team: string): FormResult[] {
  const all = teamResultsChrono(state, team);
  return all.slice(-5);
}

// Current streak like "W3" (3-match win streak), "L2", "D1", or null if none.
export function currentStreak(state: LeagueState, team: string): { kind: FormResult; count: number } | null {
  const all = teamResultsChrono(state, team);
  if (all.length === 0) return null;
  const kind = all[all.length - 1];
  let count = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i] === kind) count++;
    else break;
  }
  return { kind, count };
}

// Tailwind text color for a form pill.
export function formPillClass(r: FormResult): string {
  if (r === "W") return "bg-success text-success-foreground";
  if (r === "L") return "bg-destructive text-destructive-foreground";
  return "bg-muted text-muted-foreground";
}

// Inline color for goal-difference cell (green positive, red negative, muted 0).
export function gdColorStyle(gd: number): React.CSSProperties {
  if (gd === 0) return { color: "hsl(var(--muted-foreground))" };
  const mag = Math.min(1, Math.abs(gd) / 15);
  if (gd > 0) return { color: `color-mix(in oklab, hsl(var(--success)) ${40 + mag * 60}%, hsl(var(--foreground)))` };
  return { color: `color-mix(in oklab, hsl(var(--destructive)) ${40 + mag * 60}%, hsl(var(--foreground)))` };
}
