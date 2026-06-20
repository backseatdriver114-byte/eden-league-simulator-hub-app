// Simulation JSON Event Bridge.
// After a match completes, the engine's per-player state is read into a
// structured data payload. The v7.0/v7.1 engine tracks goals, assists and
// goalkeeper stats (saves, goals conceded, clean sheets) DIRECTLY during the
// match loop, so this bridge simply reads those values — no extra RNG draws,
// preserving the engine's deterministic event sequence. The state manager
// intercepts this payload to update league statistics (Golden Boot, Assist
// Leaders, Golden Glove), apply disciplinary counts and roll injuries.
import type { EngineTeam } from "@/engine/engine";

export interface PlayerMatchStat {
  team: string;
  name: string;
  position: string;
  goals: number;
  assists: number;
  yellow: number;
  red: boolean;
  injured: boolean;
}

export interface GoalkeeperMatchStat {
  team: string;
  name: string;
  conceded: number;
  cleanSheet: boolean;
}

export interface MatchPayload {
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  players: PlayerMatchStat[];
  goalkeepers: GoalkeeperMatchStat[];
  injuries: { team: string; name: string }[];
  log?: string[]; // full match commentary, retained for later viewing
}

export function buildMatchPayload(
  engineHome: EngineTeam,
  engineAway: EngineTeam,
  homeName: string,
  awayName: string,
  homeGoals: number,
  awayGoals: number
): MatchPayload {
  const players: PlayerMatchStat[] = [];
  const goalkeepers: GoalkeeperMatchStat[] = [];
  const injuries: { team: string; name: string }[] = [];

  const sides: { engine: EngineTeam; name: string }[] = [
    { engine: engineHome, name: homeName },
    { engine: engineAway, name: awayName },
  ];

  for (const side of sides) {
    const all = [...side.engine.active_roster, ...side.engine.bench];

    for (const p of all) {
      // "Played" mirrors the engine's own Player Condition Overview filter.
      const played =
        p.fatigue > 0 ||
        p.goals > 0 ||
        p.assists > 0 ||
        p.yellow_cards > 0 ||
        p.red_card ||
        p.injured_severe ||
        p.saves > 0;
      if (!played) continue;
      players.push({
        team: side.name,
        name: p.name,
        position: p.position,
        goals: p.goals,
        assists: p.assists,
        yellow: p.yellow_cards,
        red: p.red_card,
        injured: p.injured_severe,
      });
      if (p.injured_severe) injuries.push({ team: side.name, name: p.name });
    }

    // Goalkeeper of record: the keeper that finished the match (clean-sheet
    // credit was assigned to a GK in the engine's finalization step).
    const gk =
      all.find((p) => p.position === "GK" && (p.clean_sheets > 0 || p.goals_conceded > 0 || p.saves > 0)) ??
      all.find((p) => p.position === "GK");
    if (gk) {
      goalkeepers.push({
        team: side.name,
        name: gk.name,
        conceded: gk.goals_conceded,
        cleanSheet: gk.clean_sheets > 0,
      });
    }
  }

  return { home: homeName, away: awayName, homeGoals, awayGoals, players, goalkeepers, injuries };
}
