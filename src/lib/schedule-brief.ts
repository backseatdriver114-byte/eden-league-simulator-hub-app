// Builds the factual data brief the AI fixture generator reasons over.
// Regular season -> squad strengths + this/last-season table for fairness.
// Final Four -> current standings + form for drama. No fabricated numbers.
import type { LeagueState, StandingRow, LeagueTeam } from "@/state/league";

function squadStrength(t: LeagueTeam): number {
  const sorted = [...t.players].sort((a, b) => b.rating - a.rating).slice(0, 9);
  if (sorted.length === 0) return 0;
  return sorted.reduce((s, p) => s + p.rating, 0) / sorted.length;
}

export function buildScheduleBrief(
  state: LeagueState,
  standings: StandingRow[],
  phase: "regular" | "finalfour",
  lastSeasonSummary?: string,
): string {
  const strengths = state.teamOrder
    .map((name) => {
      const t = state.teams[name];
      return t ? `  - ${name}: squad strength ${squadStrength(t).toFixed(2)}, style ${t.tactical_style}` : `  - ${name}: n/a`;
    })
    .join("\n");

  const table = standings.length
    ? standings
        .map((r) => `  ${r.rank}. ${r.team} — ${r.pts} pts (${r.w}W ${r.d}D ${r.l}L, GD ${r.gd >= 0 ? "+" : ""}${r.gd})`)
        .join("\n")
    : "  - No standings yet.";

  if (phase === "finalfour") {
    return [
      `CURRENT STANDINGS AFTER THE 12-WEEK REGULAR SEASON (use this to make matchups dramatic — best vs best, worst vs worst):`,
      table,
      ``,
      `SQUAD STRENGTHS:`,
      strengths,
    ].join("\n");
  }

  return [
    `CLUB SQUAD STRENGTHS (use these to balance difficulty across the 12 weeks):`,
    strengths,
    ``,
    lastSeasonSummary
      ? `LAST SEASON'S FINAL TABLE (from the data archive — use for fairness and to set up compelling rivalries):\n${lastSeasonSummary}`
      : `CURRENT TABLE (last season's archive not available — use squad strengths as the fairness basis):\n${table}`,
  ].join("\n");
}
