// Match-result driven volatility: after any recorded result (SIM or MANUAL)
// this module produces respect/morale deltas for BOTH clubs based on how
// impressive the win/loss was, how strong the opponent was, and whether a
// streak was broken/extended. The volatility of each delta is scaled by
// two dedicated Settings sliders so they can be tuned independently from
// the generic "Manager Rating / Morale volatility" (which now only covers
// non-result drivers like standings drift and press).
import type { LeagueState, LeagueTeam, StandingRow } from "@/state/league";
import { currentStreak } from "@/lib/team-stats";

export interface MatchResultDeltas {
  home: { respect: number; teamMorale: number; playerMorale: number };
  away: { respect: number; teamMorale: number; playerMorale: number };
}

// Rough squad strength (average of top 9 rated players). Cheap enough to run
// per result — no engine coupling.
function squadStrength(team: LeagueTeam | undefined): number {
  if (!team) return 5;
  const top = [...team.players].sort((a, b) => b.rating - a.rating).slice(0, 9);
  return top.length === 0 ? 5 : top.reduce((s, p) => s + p.rating, 0) / top.length;
}

export function computeMatchResultDeltas(
  state: LeagueState,
  preStandings: StandingRow[],
  home: string,
  away: string,
  homeGoals: number,
  awayGoals: number,
): MatchResultDeltas {
  const rankOf = (t: string) =>
    preStandings.find((r) => r.team === t)?.rank ?? Math.ceil(state.teamOrder.length / 2);
  const total = state.teamOrder.length;
  const rankGap = (winner: string, loser: string) => {
    // Positive when winner was lower-ranked (upset), negative when winner was
    // heavy favourite. Normalized to roughly [-1, +1].
    return (rankOf(winner) - rankOf(loser)) / total;
  };

  const ht = state.teams[home];
  const at = state.teams[away];
  const strengthGap = (winner: string, loser: string) => {
    const w = winner === home ? squadStrength(ht) : squadStrength(at);
    const l = loser === home ? squadStrength(ht) : squadStrength(at);
    // Positive when the winner was the weaker side (bigger deserved credit).
    return (l - w) / 10;
  };

  const homeStreak = currentStreak(state, home);
  const awayStreak = currentStreak(state, away);

  const margin = homeGoals - awayGoals;
  const absMargin = Math.abs(margin);
  const draw = margin === 0;

  // Blank baseline.
  const out: MatchResultDeltas = {
    home: { respect: 0, teamMorale: 0, playerMorale: 0 },
    away: { respect: 0, teamMorale: 0, playerMorale: 0 },
  };

  if (draw) {
    // Draws barely move the needle — a mild positive for the underdog, mild
    // negative for the favourite, tiny for equally-matched sides.
    const favBias = squadStrength(ht) - squadStrength(at);
    out.home.respect = -favBias * 0.4;
    out.away.respect = favBias * 0.4;
    out.home.teamMorale = -favBias * 0.6;
    out.away.teamMorale = favBias * 0.6;
    out.home.playerMorale = out.home.teamMorale * 0.5;
    out.away.playerMorale = out.away.teamMorale * 0.5;
    return out;
  }

  const winner = margin > 0 ? home : away;
  const loser = margin > 0 ? away : home;
  const winnerSide = winner === home ? "home" : "away";
  const loserSide = winner === home ? "away" : "home";
  const winnerStreak = winner === home ? homeStreak : awayStreak;
  const loserStreak = winner === home ? awayStreak : homeStreak;

  // Base magnitude: how lopsided was the score?
  const base = 4 + Math.min(20, absMargin * 2.2);

  // Opponent strength bonus: bigger upset (positive rankGap) → bigger reward.
  const rankBonus = Math.max(-1, Math.min(1, rankGap(winner, loser)));
  const strengthBonus = Math.max(-1, Math.min(1, strengthGap(winner, loser)));
  const oppFactor = 1 + rankBonus * 0.6 + strengthBonus * 0.6;

  // Streak bonus: extending a hot streak or breaking a cold one both bump
  // respect/morale up; breaking a hot streak (as loser) or extending a cold
  // one hurts.
  let winnerStreakBonus = 0;
  let loserStreakBonus = 0;
  if (winnerStreak && winnerStreak.kind === "W") winnerStreakBonus = Math.min(3, winnerStreak.count);
  if (winnerStreak && winnerStreak.kind === "L") winnerStreakBonus = 1.5; // snapped a slump
  if (loserStreak && loserStreak.kind === "L") loserStreakBonus = -Math.min(3, loserStreak.count);
  if (loserStreak && loserStreak.kind === "W") loserStreakBonus = -2; // hot streak snapped

  const winnerRespect = (base * oppFactor + winnerStreakBonus) * 0.35;
  const loserRespect = -(base * (2 - oppFactor) - loserStreakBonus) * 0.35;

  const winnerTeamMorale = (base * oppFactor + winnerStreakBonus) * 0.55;
  const loserTeamMorale = -(base * (2 - oppFactor) - loserStreakBonus) * 0.55;

  const winnerPlayerMorale = winnerTeamMorale * 0.5;
  const loserPlayerMorale = loserTeamMorale * 0.5;

  out[winnerSide] = {
    respect: round(winnerRespect),
    teamMorale: round(winnerTeamMorale),
    playerMorale: round(winnerPlayerMorale),
  };
  out[loserSide] = {
    respect: round(loserRespect),
    teamMorale: round(loserTeamMorale),
    playerMorale: round(loserPlayerMorale),
  };
  return out;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
