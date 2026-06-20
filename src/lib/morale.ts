// Eden League Morale Engine — faithful TypeScript port of the EdenMoraleEngine
// Python reference. Tracks rolling Team Morale (0–100, baseline 50) and
// Individual Player Morale (0–100, baseline 50), drives a dynamic event matrix,
// scales match-simulation weights, and triggers AI managerial sackings.
import type { LeaguePlayer, LeagueTeam } from "@/state/league";
import { settings, isManualSimTeam, isContractExempt } from "@/lib/engine-settings";

// ---------------- Manager sack registry ----------------
// triggerManagerSack records the clubs whose manager was dismissed during the
// current state update. The state layer drains this immediately afterward to
// queue an AI-generated replacement manager. User-controlled (contract-exempt)
// clubs are never sacked, so they never appear here.
let sackedTeams: string[] = [];
export function drainSackedTeams(): string[] {
  const out = sackedTeams;
  sackedTeams = [];
  return out;
}

// Manual score-entry clubs bypass player-level micro events (their match
// details are never simulated). Team-level macro events still apply to them.
// The live list lives in engine-settings (editable in the Settings suite).

// Default reference values (the live, editable values live in engine-settings).
export const MORALE_BASELINE = 50;
export const SACK_THRESHOLD = 25;
export const MANAGER_RENEWAL_MORALE = 60;
export const HIGH_MORALE = 75;
export const LOW_MORALE = 35;

// Offseason morale regression: morale carries into the next season but is
// nudged back toward the baseline by up to `seasonMoraleReset` points. Anything
// within that many points of the baseline snaps exactly to the baseline.
export const SEASON_MORALE_RESET = 7;
export function carryOverMorale(morale: number): number {
  const baseline = settings.moraleBaseline;
  const reset = settings.seasonMoraleReset;
  const m = morale ?? baseline;
  if (Math.abs(m - baseline) <= reset) return baseline;
  return m > baseline ? m - reset : m + reset;
}

// --- TEAM MORALE POINT MATRIX (engine reference values) ---
export const TEAM_EVENTS = {
  elite_victory: 12, // Victory against a top-5 ranked team
  standard_victory: 8, // Victory against any standard team
  stalemate: 2, // A drawn match
  standard_defeat: -8, // A standard match loss
  upset_defeat: -15, // Losing to a bottom-5 ranked team
  underdog_playoff_run: 30, // Bottom-5 team qualifying for playoffs
  high_budget_failure: -40, // Top-5 budget team missing playoffs
  locker_room_crisis: -10, // Key player injured during a match
  locker_room_boost: 10, // Key player returning from long-term IR
  market_triumph: 8, // High-utility trade completed
  asset_depletion: -12, // Important player sold without replacement
} as const;
export type TeamEvent = keyof typeof TEAM_EVENTS;

// --- PLAYER MORALE POINT MATRIX (engine reference values) ---
export const PLAYER_EVENTS = {
  goal: 10,
  assist: 8,
  clean_sheet: 12,
  starting_selection: 5,
  bench_penalty: -10, // healthy player benched (per week)
  red_card: -15,
  yellow_card: -3,
  injured: -20,
  comeback: 15,
  career_promotion: 15, // traded to a higher-prestige club
  career_demotion: -15, // traded to a lower-prestige club
  veteran_fulfillment: 10, // offseason veteran mental progression
} as const;
export type PlayerEvent = keyof typeof PLAYER_EVENTS;

const TACTICS = [
  "Balanced", "Possession", "Counterattack", "High Press",
  "Gegenpress", "Deep Block", "Chaos Attack",
];

export function clampMorale(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// Apply a team macro event in place. Morale no longer drives sackings — the
// state layer dismisses managers based on manager RESPECT (see league.tsx
// applyRespectTick / applyManagerRespectDelta). Morale still scales match
// simulation and is bumped back up by triggerManagerSack when a sacking does
// land, but it is no longer the trigger itself.
export function applyTeamEvent(team: LeagueTeam, event: TeamEvent): boolean {
  const swing = TEAM_EVENTS[event] * settings.moraleVolatility;
  team.morale = clampMorale((team.morale ?? settings.moraleBaseline) + swing);
  return false;
}

// Fire the manager: random new tactical mentality + a "new manager bounce".
// Rather than snapping morale to a flat number, the squad recovers part of the
// way toward the renewal target (a fresh start lifts spirits but doesn't erase
// a bad run overnight).
//
// User-controlled (contract-exempt) clubs are NEVER sacked — their manager,
// tactics, and morale are left entirely under the user's control.
export function triggerManagerSack(team: LeagueTeam): void {
  if (isContractExempt(team.name)) return;
  const options = TACTICS.filter((t) => t !== team.tactical_style);
  team.tactical_style = options[Math.floor(Math.random() * options.length)];
  const current = team.morale ?? settings.moraleBaseline;
  const target = settings.managerRenewalMorale;
  // Halfway recovery toward the target, guaranteeing at least a small lift.
  team.morale = clampMorale(Math.max(current + 8, Math.round((current + target) / 2)));
  // Record the dismissal so the state layer can queue an AI replacement.
  sackedTeams.push(team.name);
}

// Apply a player micro event in place. Exempt clubs ignore player events.
export function applyPlayerEvent(
  team: LeagueTeam,
  player: LeaguePlayer,
  event: PlayerEvent
): void {
  if (isManualSimTeam(team.name)) return;
  const swing = PLAYER_EVENTS[event] * settings.moraleVolatility;
  player.morale = clampMorale((player.morale ?? settings.moraleBaseline) + swing);
}

// ---------------- Match simulation scaling ----------------
// Morale scales the attributes fed into the engine. Team morale applies a
// blanket optimization to every starter; individual morale nudges composure /
// positioning up when high, or degrades passing / tackling when low.
const ATTRS: (keyof LeaguePlayer)[] = [
  "rating", "FIN", "SHO", "PAS", "VIS", "DRI", "PAC", "STA",
  "DEF", "TAC", "POS_attr", "COM", "WR", "AGG", "STR", "AER",
];

export function teamMoraleFactor(teamMorale: number): number {
  if (teamMorale >= settings.highMorale) return 1.03;
  if (teamMorale <= settings.lowMorale) return 0.97;
  return 1.0;
}

const clampAttr = (n: number) => Math.max(1.0, Math.min(10.0, n));

// Return a shallow copy of the attribute set scaled by morale.
export function moraleScaledAttrs(
  player: LeaguePlayer,
  teamMorale: number,
  playerMorale: number
): Record<string, number> {
  const factor = teamMoraleFactor(teamMorale);
  const out: Record<string, number> = {};
  for (const key of ATTRS) {
    out[key] = clampAttr((player[key] as number) * factor);
  }
  const pm = playerMorale ?? settings.moraleBaseline;
  if (pm >= settings.highMorale) {
    out.POS_attr = clampAttr(out.POS_attr * 1.05);
    out.COM = clampAttr(out.COM * 1.05);
  } else if (pm <= settings.lowMorale) {
    out.PAS = clampAttr(out.PAS * 0.95);
    out.TAC = clampAttr(out.TAC * 0.95);
  }
  return out;
}

export function moraleLabel(morale: number): { text: string; tone: "high" | "mid" | "low" } {
  if (morale >= settings.highMorale) return { text: "Buoyant", tone: "high" };
  if (morale <= settings.lowMorale) return { text: "Fragile", tone: "low" };
  return { text: "Steady", tone: "mid" };
}
