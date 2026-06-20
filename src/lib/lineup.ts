// Matchday & Lineup Safety Validation Layer.
// A legal lineup fills every formation slot with a distinct, healthy player. Any
// player can play any outfield position, so slots are not position-gated — the
// only requirements are: every slot filled, no duplicates, all starters healthy,
// and a pool of at least 9 healthy players.
import {
  isPlayerOut, buildLineupSlots, type LeagueTeam,
} from "@/state/league";

export interface LineupValidation {
  ok: boolean;
  errors: string[];
  emergency: boolean; // healthy pool < 9 — must add players to proceed
  healthyTotal: number;
  healthyStarters: number;
  outStarters: number;
}

export function validateLineup(team: LeagueTeam): LineupValidation {
  const errors: string[] = [];
  const healthy = team.players.filter((p) => !isPlayerOut(p));
  const healthyTotal = healthy.length;
  const emergency = healthyTotal < 9;

  if (emergency) {
    errors.push(
      `${team.name} has only ${healthyTotal} healthy player${healthyTotal === 1 ? "" : "s"} — an injury crisis. Add blank or youth players to reach 9 before the match can be played.`
    );
  }

  const slots = buildLineupSlots(team.formation);
  const lineup = team.lineup;
  const filled = lineup.filter(Boolean);
  const distinct = new Set(filled);

  if (filled.length < slots.length) {
    errors.push(`${team.name}: ${slots.length - filled.length} empty lineup slot(s). Assign a player to every position.`);
  }
  if (distinct.size < filled.length) {
    errors.push(`${team.name}: the same player is used in more than one slot.`);
  }

  let healthyStarters = 0;
  let outStarters = 0;
  slots.forEach((slot, i) => {
    const name = lineup[i];
    if (!name) return;
    const player = team.players.find((p) => p.name === name);
    if (!player) {
      errors.push(`${team.name}: lineup references unknown player "${name}".`);
      return;
    }
    if (isPlayerOut(player)) {
      outStarters++;
      errors.push(`${team.name}: ${player.name} is injured/suspended and cannot start. Replace them in the ${slot.label} slot.`);
      return;
    }
    healthyStarters++;
  });

  return {
    ok: errors.length === 0,
    errors,
    emergency,
    healthyTotal,
    healthyStarters,
    outStarters,
  };
}

export function validateMatchup(home: LeagueTeam, away: LeagueTeam): LineupValidation {
  const h = validateLineup(home);
  const a = validateLineup(away);
  return {
    ok: h.ok && a.ok,
    errors: [...h.errors, ...a.errors],
    emergency: h.emergency || a.emergency,
    healthyTotal: Math.min(h.healthyTotal, a.healthyTotal),
    healthyStarters: Math.min(h.healthyStarters, a.healthyStarters),
    outStarters: h.outStarters + a.outStarters,
  };
}
