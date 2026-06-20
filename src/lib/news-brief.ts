// Builds factual digests from REAL league state for the News Suite.
// Every string returned here is derived strictly from existing data —
// no random values, no fabricated stats. The AI narrates only these facts.
import type { LeagueState, StandingRow, Leaderboards, LeagueTeam } from "@/state/league";
import type { MatchPayload } from "@/lib/match-payload";
import { calculatePlayerValue } from "@/lib/trades";

function ratingOf(state: LeagueState, team: string, name: string): string {
  const p = state.teams[team]?.players.find((pl) => pl.name === name);
  return p ? p.rating.toFixed(1) : "?";
}

// Average rating of a club's nine strongest players (rough squad strength).
function squadStrength(t: LeagueTeam): number {
  const sorted = [...t.players].sort((a, b) => b.rating - a.rating).slice(0, 9);
  if (sorted.length === 0) return 0;
  return sorted.reduce((s, p) => s + p.rating, 0) / sorted.length;
}

// Recent results for a club (most recent first), as "W/D/L vs OPP (score)".
function recentForm(state: LeagueState, team: string, n = 5): string {
  const played = state.fixtures
    .filter((f) => (f.home === team || f.away === team) && state.results[f.id])
    .sort((a, b) => b.week - a.week)
    .slice(0, n);
  if (played.length === 0) return "no games played yet";
  return played
    .map((f) => {
      const r = state.results[f.id];
      const isHome = f.home === team;
      const gf = isHome ? r.homeGoals : r.awayGoals;
      const ga = isHome ? r.awayGoals : r.homeGoals;
      const opp = isHome ? f.away : f.home;
      const res = gf > ga ? "W" : gf < ga ? "L" : "D";
      return `${res} vs ${opp} (${gf}-${ga})`;
    })
    .join(", ");
}

// Remaining (unplayed) opponents for a club, with each opponent's squad strength
// so the writer can judge how hard the run-in is.
function remainingSchedule(state: LeagueState, team: string): string {
  const upcoming = state.fixtures
    .filter((f) => (f.home === team || f.away === team) && !state.results[f.id])
    .sort((a, b) => a.week - b.week);
  if (upcoming.length === 0) return "no remaining fixtures";
  return upcoming
    .map((f) => {
      const opp = f.home === team ? f.away : f.home;
      const ot = state.teams[opp];
      const str = ot ? squadStrength(ot).toFixed(1) : "?";
      return `W${f.week} ${f.home === team ? "vs" : "@"} ${opp} (strength ${str})`;
    })
    .join(", ");
}

// A full per-club analytical context so the AI can answer hard tactical,
// injury-impact, and schedule-difficulty questions. This is the key fix for the
// newsroom defaulting to morale/top-scorer every time — now it has the WHOLE
// picture (squads, ratings, values, styles, form, run-in, absentees).
export function buildLeagueContext(
  state: LeagueState,
  standings: StandingRow[],
): string {
  const rankOf = (team: string) => standings.find((s) => s.team === team)?.rank ?? 0;
  const blocks: string[] = [];

  for (const name of state.teamOrder) {
    const t = state.teams[name];
    if (!t) continue;
    const row = standings.find((s) => s.team === name);
    const top = [...t.players].sort((a, b) => b.rating - a.rating).slice(0, 5);
    const keyPlayers = top
      .map((p) => `${p.name} (${p.position}, OVR ${p.rating.toFixed(1)}, ~$${calculatePlayerValue(p).toFixed(1)}M${p.injuryWeeks > 0 ? ", INJURED" : p.suspensionWeeks > 0 ? ", SUSPENDED" : ""})`)
      .join("; ");
    const absent = t.players
      .filter((p) => p.injuryWeeks > 0 || p.suspensionWeeks > 0)
      .map((p) => `${p.name} (${p.position}, ${p.injuryWeeks > 0 ? `injured ${p.injuryWeeks >= 99 ? "season" : `${p.injuryWeeks}wk`}` : `suspended ${p.suspensionWeeks}wk`})`)
      .join("; ") || "none";

    blocks.push(
      [
        `=== ${name} ===`,
        `League position: ${row ? `${row.rank} (${row.pts} pts, ${row.w}W ${row.d}D ${row.l}L, GD ${row.gd >= 0 ? "+" : ""}${row.gd})` : "n/a"}`,
        `Tactical style: ${t.tactical_style} · Formation: ${t.formation} · Transfer budget: ${t.budget}`,
        `Squad strength (avg of top 9 OVR): ${squadStrength(t).toFixed(2)}`,
        `Key players: ${keyPlayers}`,
        `Current absentees: ${absent}`,
        `Recent form: ${recentForm(state, name)}`,
        `Remaining schedule: ${remainingSchedule(state, name)}`,
      ].join("\n"),
    );
  }

  return [
    `LEAGUE-WIDE ANALYTICAL CONTEXT (season ${state.season}, week ${state.currentWeek}) — use this to reason about WHY results happen and to answer tactical / injury / schedule questions:`,
    ``,
    `HOW THE MATCH ENGINE WEIGHS THINGS (so you can analyse credibly): match outcomes are driven by per-player attributes on a 1-10 scale (finishing, pace, passing, vision, defending, tackling, stamina, strength, aerial, composure, work rate, positioning), the team's tactical style and whether it matches their favoured identity, fatigue over the match, momentum swings, and a blowout dampener that suppresses scoring once a side is well ahead. A higher squad strength and a tactical style that suits the personnel generally win out, but fatigue, injuries to key players, and tough run-ins can swing things.`,
    ``,
    blocks.join("\n\n"),
  ].join("\n");
}



function describePlayers(state: LeagueState, payload: MatchPayload): string {
  const lines: string[] = [];
  for (const p of payload.players ?? []) {
    const bits: string[] = [];
    if (p.goals > 0) bits.push(`${p.goals} goal${p.goals > 1 ? "s" : ""}`);
    if (p.assists > 0) bits.push(`${p.assists} assist${p.assists > 1 ? "s" : ""}`);
    if (p.yellow > 0) bits.push(`${p.yellow} yellow`);
    if (p.red) bits.push("red card");
    if (p.injured) bits.push("injured");
    if (bits.length === 0) continue;
    lines.push(
      `  - ${p.name} (${p.team}, ${p.position}, rating ${ratingOf(state, p.team, p.name)}): ${bits.join(", ")}`
    );
  }
  return lines.length ? lines.join("\n") : "  - No individual events recorded.";
}

export function buildPostgameBrief(state: LeagueState, fixtureId: string, standings: StandingRow[]): string | null {
  const payload = state.payloads[fixtureId];
  const result = state.results[fixtureId];
  if (!payload || !result) return null;
  const fixture = state.fixtures.find((f) => f.id === fixtureId);
  const week = fixture?.week;

  const homeStyle = state.teams[payload.home]?.tactical_style ?? "?";
  const awayStyle = state.teams[payload.away]?.tactical_style ?? "?";

  const gkLines = (payload.goalkeepers ?? [])
    .map(
      (g) =>
        `  - ${g.name} (${g.team}): conceded ${g.conceded}${g.cleanSheet ? ", CLEAN SHEET" : ""}`
    )
    .join("\n");

  const injuries = (payload.injuries ?? []).length
    ? (payload.injuries ?? []).map((i) => `  - ${i.name} (${i.team})`).join("\n")
    : "  - None";

  return [
    `MATCH: ${payload.home} vs ${payload.away}${week ? ` (Week ${week})` : ""}`,
    `FINAL SCORE: ${payload.home} ${result.homeGoals} – ${result.awayGoals} ${payload.away}`,
    `Tactical styles: ${payload.home} play "${homeStyle}", ${payload.away} play "${awayStyle}".`,
    ``,
    `KEY PLAYER EVENTS:`,
    describePlayers(state, payload),
    ``,
    `GOALKEEPERS:`,
    gkLines || "  - Not recorded.",
    ``,
    `INJURIES IN THIS MATCH:`,
    injuries,
    ``,
    buildLeagueContext(state, standings),
  ].join("\n");
}

function topScorers(lb: Leaderboards, n: number): string {
  return lb.scorers.slice(0, n)
    .map((s, i) => `  ${i + 1}. ${s.name} (${s.team}) — ${s.goals} goals, ${s.assists} assists`)
    .join("\n") || "  - No goals recorded yet.";
}

export function buildRoundupBrief(
  state: LeagueState,
  standings: StandingRow[],
  leaderboards: Leaderboards,
  week: number
): string | null {
  const weekFixtures = state.fixtures.filter((f) => f.week === week && state.results[f.id]);
  if (weekFixtures.length === 0) return null;

  const resultsLines = weekFixtures.map((f) => {
    const r = state.results[f.id];
    return `  - ${f.home} ${r.homeGoals} – ${r.awayGoals} ${f.away}`;
  }).join("\n");

  const tableTop = standings.slice(0, 6)
    .map((row) => `  ${row.rank}. ${row.team} — ${row.pts} pts (${row.w}W ${row.d}D ${row.l}L, GD ${row.gd >= 0 ? "+" : ""}${row.gd})`)
    .join("\n");

  const tableBottom = standings.slice(-3)
    .map((row) => `  ${row.rank}. ${row.team} — ${row.pts} pts (GD ${row.gd >= 0 ? "+" : ""}${row.gd})`)
    .join("\n");

  return [
    `EDEN LEAGUE — WEEK ${week} ROUNDUP`,
    ``,
    `WEEK ${week} RESULTS:`,
    resultsLines,
    ``,
    `STANDINGS (top of the table):`,
    tableTop,
    ``,
    `STANDINGS (bottom of the table):`,
    tableBottom,
    ``,
    `GOLDEN BOOT RACE (top scorers, season to date — supporting detail only, not the mandatory focus):`,
    topScorers(leaderboards, 5),
    ``,
    buildLeagueContext(state, standings),
  ].join("\n");
}

export function buildDramaBrief(
  state: LeagueState,
  standings: StandingRow[],
  leaderboards: Leaderboards
): string {
  // Team morale extremes (real values stored on each team).
  const moraleSorted = state.teamOrder
    .map((name) => ({ name, morale: state.teams[name]?.morale ?? 50 }))
    .sort((a, b) => b.morale - a.morale);
  const happiest = moraleSorted.slice(0, 3)
    .map((t) => `  - ${t.name}: morale ${Math.round(t.morale)}`).join("\n");
  const unhappiest = moraleSorted.slice(-3)
    .map((t) => `  - ${t.name}: morale ${Math.round(t.morale)}`).join("\n");

  // Long-term / season-ending injuries currently on the books.
  const injured: string[] = [];
  for (const name of state.teamOrder) {
    for (const p of state.teams[name]?.players ?? []) {
      if (p.injuryWeeks > 0) injured.push(`  - ${p.name} (${name}): out ${p.injuryWeeks >= 99 ? "for the season" : `${p.injuryWeeks} wk`}`);
      else if (p.suspensionWeeks > 0) injured.push(`  - ${p.name} (${name}): suspended ${p.suspensionWeeks} wk`);
    }
  }

  const leader = standings[0];
  const chaser = standings[1];

  return [
    `EDEN LEAGUE — STORYLINES & DRAMA (season ${state.season}, week ${state.currentWeek})`,
    ``,
    leader
      ? `TITLE PICTURE: ${leader.team} lead on ${leader.pts} pts${chaser ? `, chased by ${chaser.team} on ${chaser.pts} pts (gap ${leader.pts - chaser.pts})` : ""}.`
      : `TITLE PICTURE: season not yet underway.`,
    ``,
    `DRESSING ROOMS IN GOOD SPIRITS (highest team morale):`,
    happiest,
    ``,
    `DRESSING ROOMS UNDER PRESSURE (lowest team morale):`,
    unhappiest,
    ``,
    `TOP SCORERS (season to date):`,
    topScorers(leaderboards, 5),
    ``,
    `CURRENT ABSENTEES (injuries & suspensions — supporting detail only, not the mandatory focus):`,
    injured.length ? injured.slice(0, 12).join("\n") : "  - Full squads available across the league.",
    ``,
    buildLeagueContext(state, standings),
  ].join("\n");
}
