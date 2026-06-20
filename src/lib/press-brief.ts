// Press Brief — factual digest passed to the press-conference AI.
// Pulls real standings, recent results, key players, injuries, contracts, and
// rivals from current league state. No invented stats.
import type { LeagueState, StandingRow, Leaderboards } from "@/state/league";
import { isPlayerOut, SEASON_ENDING_WEEKS } from "@/state/league";

export type PressContext = "general" | "pre" | "post";

interface PressBriefArgs {
  state: LeagueState;
  standings: StandingRow[];
  leaderboards: Leaderboards;
  team: string;
  context: PressContext;
  fixtureId?: string; // for pre/post-match context
}

export function buildPressBrief({
  state, standings, leaderboards, team, context, fixtureId,
}: PressBriefArgs): string | null {
  const t = state.teams[team];
  if (!t) return null;
  const row = standings.find((s) => s.team === team);

  const fixture = fixtureId ? state.fixtures.find((f) => f.id === fixtureId) : undefined;
  const opponent = fixture
    ? (fixture.home === team ? fixture.away : fixture.home)
    : undefined;

  const last3 = state.fixtures
    .filter((f) => state.results[f.id] && (f.home === team || f.away === team))
    .sort((a, b) => b.week - a.week)
    .slice(0, 3)
    .map((f) => {
      const r = state.results[f.id];
      const homeMark = f.home === team ? "(H)" : "(A)";
      return `  - W${f.week} ${homeMark} ${f.home} ${r.homeGoals}-${r.awayGoals} ${f.away}`;
    })
    .join("\n") || "  - (no completed matches yet)";

  const topScorers = leaderboards.scorers
    .filter((s) => s.team === team)
    .slice(0, 4)
    .map((s) => `  - ${s.name}: ${s.goals}G ${s.assists}A`)
    .join("\n") || "  - (no goals yet)";

  const injured = t.players
    .filter((p) => p.injuryWeeks > 0)
    .slice(0, 8)
    .map((p) => `  - ${p.name} (${p.position}, ${p.injuryWeeks >= SEASON_ENDING_WEEKS ? "out for season" : `${p.injuryWeeks}wk`})`)
    .join("\n");
  const suspended = t.players
    .filter((p) => p.suspensionWeeks > 0 && p.injuryWeeks === 0)
    .slice(0, 4)
    .map((p) => `  - ${p.name} (${p.position}, ${p.suspensionWeeks}wk ban)`)
    .join("\n");

  const keyPlayers = [...t.players]
    .filter((p) => !isPlayerOut(p))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 6)
    .map((p) => `  - ${p.name} (${p.position}) OVR ${p.rating.toFixed(1)} morale ${(p.morale ?? 50).toFixed(0)}`)
    .join("\n");

  const lowMorale = t.players
    .filter((p) => (p.morale ?? 50) < 35)
    .slice(0, 4)
    .map((p) => `  - ${p.name} morale ${(p.morale ?? 50).toFixed(0)}`)
    .join("\n");

  const expiring = t.players
    .filter((p) => p.contractYears === 1)
    .slice(0, 4)
    .map((p) => `  - ${p.name} (final year)`)
    .join("\n");

  let opponentBlock = "";
  if (opponent && state.teams[opponent]) {
    const op = state.teams[opponent];
    const opRow = standings.find((s) => s.team === opponent);
    const opStars = [...op.players]
      .filter((p) => !isPlayerOut(p))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 3)
      .map((p) => `${p.name} (${p.position}, OVR ${p.rating.toFixed(1)})`)
      .join(", ");
    opponentBlock = [
      ``,
      `OPPONENT this week: ${opponent} — rank ${opRow?.rank ?? "?"}, ${opRow?.w ?? 0}W ${opRow?.d ?? 0}D ${opRow?.l ?? 0}L.`,
      `  Key players: ${opStars}`,
      `  Tactical style: ${op.tactical_style}`,
    ].join("\n");
  }

  const recentResultLine = fixture && context === "post"
    ? (() => {
        const r = state.results[fixture.id];
        if (!r) return "";
        const teamGoals = fixture.home === team ? r.homeGoals : r.awayGoals;
        const oppGoals = fixture.home === team ? r.awayGoals : r.homeGoals;
        const outcome = teamGoals > oppGoals ? "WIN" : teamGoals < oppGoals ? "LOSS" : "DRAW";
        return `\nJUST PLAYED: ${outcome} ${teamGoals}-${oppGoals} vs ${opponent}.`;
      })()
    : "";

  // Public press archive — quotes the manager has on the record, plus any
  // recent quotes from rival managers (especially the opponent). Lets the
  // press corps reference past statements ("Last week you said…").
  const archive = state.pressArchive ?? [];
  const ownQuotes = archive
    .filter((e) => e.team === team)
    .slice(-6)
    .map((e) => `  - S${e.season}W${e.week} (${e.context}) ${e.managerName}: "${truncate(e.answer, 220)}" (re: "${truncate(e.question, 120)}")`)
    .join("\n");
  const rivalQuotes = archive
    .filter((e) => e.team !== team)
    .filter((e) => {
      // Keep quotes that mention this team / its players / its manager, plus
      // anything the opponent said.
      if (opponent && e.team === opponent) return true;
      const ts = e.targets ?? [];
      return ts.some((t) =>
        (t.kind === "team" && t.name === team) ||
        (t.kind === "player" && t.team === team) ||
        (t.kind === "manager" && t.team === team),
      );
    })
    .slice(-6)
    .map((e) => `  - S${e.season}W${e.week} ${e.managerName} (${e.team}): "${truncate(e.answer, 220)}"`)
    .join("\n");

  return [
    `SEASON ${state.season}, WEEK ${state.currentWeek}.`,
    `${team} — tactical style "${t.tactical_style}", morale ${t.morale.toFixed(0)}/100.`,
    `Standings: ${row ? `Rank ${row.rank}/${standings.length}, ${row.w}W ${row.d}D ${row.l}L, GD ${row.gd > 0 ? "+" : ""}${row.gd}, ${row.pts} pts.` : "(not ranked yet)"}`,
    recentResultLine,
    ``,
    `LAST 3 RESULTS:`,
    last3,
    ``,
    `TOP CONTRIBUTORS:`,
    topScorers,
    ``,
    `KEY AVAILABLE PLAYERS:`,
    keyPlayers,
    injured ? `\nINJURED:\n${injured}` : "",
    suspended ? `\nSUSPENDED:\n${suspended}` : "",
    lowMorale ? `\nLOW-MORALE PLAYERS:\n${lowMorale}` : "",
    expiring ? `\nCONTRACT EXPIRING NEXT:\n${expiring}` : "",
    opponentBlock,
    ownQuotes ? `\nRECENT PRESS QUOTES FROM ${managerNameFor(state, team)} (use to follow up on prior statements):\n${ownQuotes}` : "",
    rivalQuotes ? `\nRELEVANT PRESS QUOTES FROM RIVAL MANAGERS (about ${team}, its players, or the opponent — use to surface tension):\n${rivalQuotes}` : "",
  ].filter(Boolean).join("\n");
}

function truncate(s: string, n: number): string {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
function managerNameFor(state: LeagueState, team: string): string {
  return state.managers?.[team]?.name ?? "the manager";
}
