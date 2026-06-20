// =============================================================================
// EDEN LEAGUE SIMULATION ENGINE v7.0 / v7.1 — faithful TypeScript port.
// Ported line-for-line from the official Python engines:
//   - v7.0 (logic only)            -> regular-season matches
//   - v7.1 (playoff edition)       -> playoff matches (penalty shootouts)
// The mathematics, random ranges, tactical weightings, fatigue decay, weather
// effects, event loop ordering and commentary text are preserved EXACTLY.
// Only Python `print()` calls become log pushes and the CLI harness is replaced
// by the UI bridge. DO NOT alter any formula.
// =============================================================================

import { settings } from "@/lib/engine-settings";

export const GOAL_MULTIPLIER_DEFAULT = 0.6;
export const IDENTITY_BOOST_WEIGHT = 0.6;

// ---------------------------------------------------------------------------
// EDITABLE TUNING HOOKS (these read live Settings knobs — they do not alter the
// ported RNG/event ordering; they only scale inputs/probabilities).
// ---------------------------------------------------------------------------

// Blowout dampener: once the leading side is `blowoutThreshold` goals up, every
// shooting probability is scaled down based on how many goals deep into blowout
// territory the match is. The suppression now grows EXPONENTIALLY with each goal
// of the lead (rather than the old flat linear `1 + depth*decay`), and because
// the engine re-evaluates this every shot using the LIVE current margin, it also
// RELAXES back toward 1.0 automatically when the trailing side scores and the
// gap shrinks below the threshold. `blowoutDecay` is the steepness exponent:
// higher = more aggressively exponential per-goal suppression, lower = gentler,
// 0 (or below) disables it entirely.
function blowout_modifier(score_margin: number): number {
  const threshold = settings.blowoutThreshold;
  const steepness = settings.blowoutDecay;
  if (!Number.isFinite(steepness) || steepness <= 0) return 1.0;
  if (!Number.isFinite(threshold) || score_margin < threshold) return 1.0;
  const depth = score_margin - threshold + 1; // goals deep into blowout territory
  // Exponential: each extra goal of lead bites harder than the last. The
  // `steepness` knob shapes how fast the penalty escalates. Clamp the modifier
  // so it can never fully kill scoring (floor 0.05) — upsets stay possible.
  const penalty = Math.pow(depth, 1 + steepness) * steepness;
  return Math.max(0.05, 1.0 / (1.0 + penalty));
}

// Parity multiplier: scales how far each player's attributes sit from the 5.0
// midpoint. 1.0 = untouched; <1.0 compresses skill gaps (closer games / upsets);
// >1.0 exaggerates them (favourites dominate). Applied once at team build, so the
// match math and RNG sequence are completely unchanged.
const PARITY_ATTRS = [
  "FIN", "SHO", "PAS", "VIS", "DRI", "PAC", "STA", "DEF", "TAC",
  "POS_attr", "COM", "WR", "AGG", "STR", "AER",
] as const;
function parity_scale(v: number): number {
  const p = settings.parityMultiplier;
  if (!Number.isFinite(p) || p === 1.0) return v;
  return Math.max(1.0, Math.min(10.0, 5.0 + (v - 5.0) * p));
}

// ---- RNG helpers mirroring Python's `random` module semantics ----
function uniform(a: number, b: number): number {
  return a + Math.random() * (b - a);
}
function randint(a: number, b: number): number {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}
function choice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
// random.choices(population, weights=..., k=1)[0]
function weightedChoice<T>(population: T[], weights: number[]): T {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return choice(population);
  let r = Math.random() * total;
  for (let i = 0; i < population.length; i++) {
    r -= weights[i];
    if (r <= 0) return population[i];
  }
  return population[population.length - 1];
}
function mean(arr: number[]): number {
  if (arr.length === 0) return 0; // guard against divide-by-zero (NaN) on empty rosters
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export interface EnginePlayer {
  name: string;
  position: string;
  rating: number;
  FIN: number; SHO: number; PAS: number; VIS: number; DRI: number; PAC: number;
  STA: number; DEF: number; TAC: number; POS_attr: number; COM: number; WR: number;
  AGG: number; STR: number; AER: number;
  fatigue: number;
  goals: number;
  assists: number;
  fouls: number;
  yellow_cards: number;
  red_card: boolean;
  injured_severe: boolean;
  // Goalkeeper tracking
  saves: number;
  goals_conceded: number;
  clean_sheets: number;
}

export interface EngineTeam {
  name: string;
  tactical_style: string;
  favored_style: string;
  active_roster: EnginePlayer[];
  bench: EnginePlayer[];
  goals_scored: number;
  subs_made: number;
  // Live momentum + advanced match stats
  momentum: number;
  shots: number;
  shots_on_target: number;
  fouls_committed: number;
  corners_won: number;
  xg_total: number;
  possession_ticks: number;
}

function get_stamina_reduction(p: EnginePlayer): number {
  return p.STA * 0.03;
}

function get_top_aer_avg(team: EngineTeam): number {
  const outfielders = team.active_roster.filter((p) => p.position !== "GK");
  outfielders.sort((a, b) => b.AER - a.AER);
  const top_6 = outfielders.slice(0, 6);
  return top_6.length ? mean(top_6.map((p) => p.AER)) : 5.0;
}

function count_positions(team: EngineTeam): [number, number] {
  const attackers = team.active_roster.filter((p) =>
    ["ST", "LW", "RW", "Winger", "CAM"].includes(p.position)
  ).length;
  const defenders = team.active_roster.filter((p) =>
    ["CB", "LB", "RB", "LWB", "RWB", "CDM", "CM"].includes(p.position)
  ).length;
  return [attackers, defenders];
}

// Build a fresh, mutable engine Team from a roster (starters first 9, rest bench).
export function buildEngineTeam(
  name: string,
  tactical_style: string,
  roster: Omit<
    EnginePlayer,
    | "fatigue" | "goals" | "assists" | "fouls" | "yellow_cards" | "red_card"
    | "injured_severe" | "saves" | "goals_conceded" | "clean_sheets"
  >[]
): EngineTeam {
  const players: EnginePlayer[] = roster.map((r) => {
    // Apply the live Parity Multiplier to every raw attribute (and the overall
    // rating) before the match math touches them. parity_scale is a no-op at 1.0.
    const scaled: typeof r = { ...r, rating: parity_scale(r.rating) };
    for (const k of PARITY_ATTRS) {
      (scaled as unknown as Record<string, number>)[k] = parity_scale(
        (r as unknown as Record<string, number>)[k]
      );
    }
    return {
      ...scaled,
      fatigue: 0.0,
      goals: 0,
      assists: 0,
      fouls: 0,
      yellow_cards: 0,
      red_card: false,
      injured_severe: false,
      saves: 0,
      goals_conceded: 0,
      clean_sheets: 0,
    };
  });
  return {
    name,
    tactical_style,
    favored_style: tactical_style,
    active_roster: players.slice(0, 9),
    bench: players.slice(9),
    goals_scored: 0,
    subs_made: 0,
    momentum: 1.0,
    shots: 0,
    shots_on_target: 0,
    fouls_committed: 0,
    corners_won: 0,
    xg_total: 0.0,
    possession_ticks: 0.0,
  };
}

type Log = string[];
const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);
const padR = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

// =============================================================================
// MATCH ENVIRONMENT (weather + referee strictness)
// =============================================================================
interface MatchEnvironment {
  weather_name: string;
  pass_mod: number;
  fatigue_mod: number;
  injury_mod: number;
  ref_strictness: number;
}

function makeEnvironment(): MatchEnvironment {
  // Weather effects can be toggled off in Settings: every match then plays in
  // neutral Clear/Sunny conditions (no pass/fatigue/injury modifiers).
  if (!settings.weatherEffects) {
    return { weather_name: "Clear/Sunny", pass_mod: 1.0, fatigue_mod: 1.0, injury_mod: 1.0, ref_strictness: randint(1, 10) };
  }
  const conditions: [string, number, number, number][] = [
    ["Clear/Sunny", 1.0, 1.0, 1.0],
    ["Heavy Rain", 0.9, 1.15, 1.15],
    ["Snow", 0.85, 1.25, 1.3],
    ["Extreme Heat", 1.0, 1.4, 1.0],
  ];
  const [weather_name, pass_mod, fatigue_mod, injury_mod] = weightedChoice(
    conditions,
    [60, 20, 10, 10]
  );
  return { weather_name, pass_mod, fatigue_mod, injury_mod, ref_strictness: randint(1, 10) };
}

// =============================================================================
// EDEN MIDGAME TACTICAL SUB-ENGINE
// =============================================================================
const TACT_ATTRS = [
  "PAS", "COM", "DRI", "DEF", "TAC", "STR", "PAC", "VIS", "FIN", "SHO", "AER", "STA", "WR", "AGG",
] as const;

function get_team_outfield_averages(team: EngineTeam): Record<string, number> {
  const outfielders = team.active_roster.filter((p) => p.position !== "GK");
  const out: Record<string, number> = {};
  if (!outfielders.length) {
    for (const attr of TACT_ATTRS) out[attr] = 5.0;
    return out;
  }
  for (const attr of TACT_ATTRS) {
    out[attr] = mean(outfielders.map((p) => (p as unknown as Record<string, number>)[attr]));
  }
  return out;
}

function calculate_style_suitability_scores(
  team: EngineTeam,
  opponent: EngineTeam
): Record<string, number> {
  const us = get_team_outfield_averages(team);
  const them = get_team_outfield_averages(opponent);

  const opponent_gk = opponent.active_roster.find((p) => p.position === "GK") || null;
  const opp_gk_rating = opponent_gk ? opponent_gk.rating : 5.0;

  const scores: Record<string, number> = {};
  scores["Possession"] = 1.0 * mean([us["PAS"], us["DRI"], us["COM"]]) + 0.2 * (5.0 - them["DEF"]);
  scores["Counterattack"] = 1.0 * mean([us["PAC"], us["VIS"], us["PAS"]]) + 0.2 * (them["FIN"] - 5.0);
  scores["Deep Block"] = 1.0 * mean([us["DEF"], us["TAC"], us["STR"]]) + 0.2 * (them["PAC"] - 5.0);
  scores["Chaos Attack"] = 1.0 * mean([us["FIN"], us["SHO"], us["AER"]]) + 0.2 * (5.0 - opp_gk_rating);
  scores["High Press"] =
    1.0 * mean([us["STA"], us["WR"], us["AGG"]]) + 0.2 * (5.0 - mean([them["PAS"], them["COM"]]));
  scores["Balanced"] = 5.0;

  if (team.favored_style in scores) scores[team.favored_style] += settings.identityBoostWeight;

  return scores;
}

function maxKey(scores: Record<string, number>): string {
  let best = "";
  let bestVal = -Infinity;
  for (const k of Object.keys(scores)) {
    if (scores[k] > bestVal) {
      bestVal = scores[k];
      best = k;
    }
  }
  return best;
}

function choose_initial_tactic(team: EngineTeam, opponent: EngineTeam, log: Log): string {
  const scores = calculate_style_suitability_scores(team, opponent);
  const best_style = maxKey(scores);
  team.tactical_style = best_style;

  log.push(`[PRE MATCH ANALYTICS] ${team.name} Manager Strategy vs ${opponent.name}:`);
  for (const style of Object.keys(scores)) {
    const is_favored = style === team.favored_style ? " (Favored)" : "";
    log.push(`   -> ${padR(style, 15)}: Suitability Score = ${f2(scores[style])}${is_favored}`);
  }
  log.push(`   => SYSTEM DECISION: AI selects '${best_style}' for kickoff.\n`);

  return best_style;
}

function evaluate_live_tactics(
  team: EngineTeam,
  opponent: EngineTeam,
  current_minute: number,
  score_margin: number,
  last_change_minute: number,
  log: Log
): string {
  const current_style = team.tactical_style;

  if (score_margin <= -4) {
    if (current_style !== "Deep Block") {
      team.tactical_style = "Deep Block";
      log.push(
        `[${f1(current_minute)}'] !!! DAMAGE CONTROL !!! ${team.name} is being humiliated. Parking the bus.`
      );
      return "Deep Block";
    }
    return current_style;
  }

  const time_since_change = current_minute - last_change_minute;
  const is_emergency =
    (score_margin <= -3 && current_style !== "Chaos Attack") ||
    (score_margin <= -2 && current_minute >= 80.0 && current_style !== "Chaos Attack");

  if (!is_emergency && time_since_change < 15.0) return current_style;

  const scores = calculate_style_suitability_scores(team, opponent);

  if (is_emergency) {
    team.tactical_style = "Chaos Attack";
    log.push(
      `[${f1(current_minute)}'] !!! AI MANAGER EMERGENCY OVERRIDE !!! ${team.name} throws caution to the wind -> 'Chaos Attack'!`
    );
    return "Chaos Attack";
  }

  let target_style = current_style;
  if (score_margin === -1) {
    const best_attack_style = ["Chaos Attack", "High Press"].reduce((a, b) =>
      scores[b] > scores[a] ? b : a
    );
    if (scores[best_attack_style] > scores[current_style] + 2.0) target_style = best_attack_style;
  } else if (score_margin >= 1) {
    if (current_minute >= 75.0) target_style = "Deep Block";
    else if (current_minute >= 60.0)
      target_style = ["Deep Block", "Counterattack"].reduce((a, b) => (scores[b] > scores[a] ? b : a));
    else {
      const outfield = team.active_roster.filter((p) => p.position !== "GK");
      const avgFat = outfield.length ? mean(outfield.map((p) => p.fatigue)) : 0.0;
      if (
        ["High Press", "Gegenpress", "Chaos Attack"].includes(current_style) &&
        avgFat >= 50.0
      ) {
        target_style = ["Possession", "Counterattack", "Balanced"].reduce((a, b) =>
          scores[b] > scores[a] ? b : a
        );
      }
    }
  } else {
    const best_suited_style = maxKey(scores);
    if (scores[best_suited_style] > scores[current_style] + 2.0) target_style = best_suited_style;
  }

  if (target_style !== current_style) {
    team.tactical_style = target_style;
    log.push(
      `[${f1(current_minute)}'] TACTICAL SHIFT (${team.name}): AI Manager pivots plan from '${current_style}' to '${target_style}'.`
    );
    return target_style;
  }
  return current_style;
}

// =============================================================================
// INJURY, DISCIPLINARY, AND ASSIST MECHANICS
// =============================================================================
function select_assister(attacking_team: EngineTeam, shooter: EnginePlayer): EnginePlayer | null {
  const eligible = attacking_team.active_roster.filter((p) => p !== shooter && p.position !== "GK");
  if (!eligible.length) return null;

  const weights: number[] = [];
  for (const p of eligible) {
    let pos_mod = 1.0;
    if (["CAM", "LW", "RW", "LM", "RM", "Winger"].includes(p.position)) pos_mod = 2.0;
    else if (["CM", "CDM"].includes(p.position)) pos_mod = 1.5;
    else if (["CB", "LB", "RB", "LWB", "RWB"].includes(p.position)) pos_mod = 0.5;
    weights.push((p.PAS * 1.5 + p.VIS) * pos_mod);
  }
  if (weights.reduce((s, w) => s + w, 0) <= 0) return choice(eligible);
  return weightedChoice(eligible, weights);
}

function execute_foul(
  fouling_team: EngineTeam,
  current_TUP: number,
  env: MatchEnvironment,
  events_log: Log,
  log: Log
): void {
  fouling_team.fouls_committed += 1;
  const eligible = fouling_team.active_roster.filter((p) => p.position !== "GK");
  if (!eligible.length) return;

  const fouler = choice(eligible);
  const roll = uniform(1, 100);

  const ref_mod = env.ref_strictness - 5.0;
  const red_thresh = 99.85 - ref_mod * 0.1;
  const yellow_thresh = 94.0 - (fouler.AGG - 5) * 1.0 - fouler.fouls * 2.0 - ref_mod * 1.5;

  if (roll >= red_thresh) {
    log.push(`[${f1(current_TUP)}'] RED CARD! ${fouler.name} (${fouling_team.name}) is sent off!`);
    events_log.push(
      `[${f1(current_TUP)}'] RED CARD - ${fouler.name} (${fouling_team.name}) [Ref Strictness: ${env.ref_strictness}/10]`
    );
    fouler.red_card = true;
    fouling_team.active_roster = fouling_team.active_roster.filter((p) => p !== fouler);
    fouling_team.momentum = Math.max(0.85, fouling_team.momentum - 0.08);
  } else if (roll >= yellow_thresh) {
    fouler.yellow_cards += 1;
    fouler.fouls = 0;
    log.push(`[${f1(current_TUP)}'] YELLOW CARD: ${fouler.name} (${fouling_team.name}) is booked.`);
    events_log.push(`[${f1(current_TUP)}'] YELLOW CARD - ${fouler.name} (${fouling_team.name})`);
    if (fouler.yellow_cards === 2) {
      log.push(`   -> SECOND YELLOW! ${fouler.name} receives his marching orders!`);
      events_log.push(`[${f1(current_TUP)}'] SECOND YELLOW (RED) - ${fouler.name} (${fouling_team.name})`);
      fouler.red_card = true;
      fouling_team.active_roster = fouling_team.active_roster.filter((p) => p !== fouler);
      fouling_team.momentum = Math.max(0.85, fouling_team.momentum - 0.08);
    }
  } else {
    fouler.fouls += 1;
    log.push(`[${f1(current_TUP)}'] Foul whistled on ${fouler.name} (${fouling_team.name}).`);
  }
}

function check_injuries(
  team: EngineTeam,
  current_TUP: number,
  env: MatchEnvironment,
  events_log: Log,
  log: Log
): void {
  for (const p of [...team.active_roster]) {
    if (p.position === "GK") continue;
    const roll = uniform(1, 100);

    let thresh = 99.85 + (p.STR - 5) * 0.05 - (p.fatigue / 10.0) * 0.03;
    thresh -= (env.injury_mod - 1.0) * 5.0;

    if (roll >= thresh) {
      const severity_roll = uniform(1, 100) - p.STR * 3.0;
      if (severity_roll > 55.0) {
        log.push(
          `[${f1(current_TUP)}'] SEVERE INJURY! ${p.name} (${team.name}) collapses and must be carried off!`
        );
        events_log.push(`[${f1(current_TUP)}'] INJURY - ${p.name} (${team.name}) forced off.`);
        p.injured_severe = true;
        team.momentum = Math.max(0.85, team.momentum - 0.05);
        team.active_roster = team.active_roster.filter((x) => x !== p);
        // Keep the carried-off player on the roster object (bench) so the
        // post-match payload bridge can record the injury. Sub-selection logic
        // already filters out injured_severe players, so this is bookkeeping
        // only and does not change the simulation or RNG sequence.
        if (!team.bench.includes(p)) team.bench.push(p);
        force_emergency_sub(team, p, current_TUP, log);
      } else {
        log.push(`[${f1(current_TUP)}'] MINOR INJURY: ${p.name} (${team.name}) picks up a knock.`);
        p.rating = Math.max(1.0, p.rating - 1.0);
      }
    }
  }
}

function force_emergency_sub(
  team: EngineTeam,
  injured_player: EnginePlayer,
  TUP: number,
  log: Log
): void {
  if (team.subs_made >= 5) {
    log.push(
      `   -> NO SUBS REMAINING! ${team.name} has already used all 5 substitutions and must play with ${team.active_roster.length} men.`
    );
    return;
  }

  const candidates = team.bench.filter((b) => !b.injured_severe);
  if (!candidates.length) {
    log.push(`   -> NO HEALTHY RESERVES! ${team.name} will play with ${team.active_roster.length} men.`);
    return;
  }

  const match_score = (c: EnginePlayer): number => {
    let score = 0;
    const ip = injured_player.position;
    if (c.position === ip) score += 100;
    else if (
      ["ST", "LW", "RW", "CAM"].includes(c.position) &&
      ["ST", "LW", "RW", "CAM"].includes(ip)
    )
      score += 50;
    else if (
      ["CB", "LB", "RB", "LWB", "RWB"].includes(c.position) &&
      ["CB", "LB", "RB", "LWB", "RWB"].includes(ip)
    )
      score += 50;
    else if (
      ["CM", "CDM", "LM", "RM"].includes(c.position) &&
      ["CM", "CDM", "LM", "RM"].includes(ip)
    )
      score += 50;
    score += c.rating;
    return score;
  };

  candidates.sort((a, b) => match_score(b) - match_score(a));
  const sub = candidates[0];

  team.bench = team.bench.filter((b) => b !== sub);
  team.active_roster.push(sub);
  team.subs_made += 1;
  log.push(
    `   -> EMERGENCY SUB: ${sub.name} (${sub.position}) ON for ${injured_player.name} (${injured_player.position}).`
  );
}

// =============================================================================
// PHASE 1: POSSESSION BUILDUP
// =============================================================================
function weighted_possession_flip(team_A: EngineTeam, team_B: EngineTeam): [EngineTeam, EngineTeam] {
  const get_mid_score = (team: EngineTeam): number => {
    const mids = team.active_roster.filter((p) =>
      ["CM", "CDM", "CAM", "LM", "RM"].includes(p.position)
    );
    if (!mids.length) return 15.0;
    return mids.reduce((s, p) => s + p.PAS + p.DRI + p.POS_attr, 0) / mids.length;
  };

  const score_A = get_mid_score(team_A);
  const score_B = get_mid_score(team_B);

  const prob_A = (score_A ** 3 / (score_A ** 3 + score_B ** 3)) * 100;
  return uniform(1, 100) <= prob_A ? [team_A, team_B] : [team_B, team_A];
}

function calculate_PRV(offense: EngineTeam, defense: EngineTeam, env: MatchEnvironment): number {
  const off_att = mean(offense.active_roster.map((p) => p.PAS + p.VIS + p.DRI + p.PAC)) / 4;
  const off_phys =
    mean(offense.active_roster.map((p) => p.POS_attr + p.COM + p.AGG + p.STA + p.WR + p.STR)) / 6;
  const [num_att] = count_positions(offense);
  let off_score = off_att * 1.2 + off_phys * 0.8 + num_att * 0.5;

  if (!defense.active_roster.length) return 99.0;
  const def_tech = mean(defense.active_roster.map((p) => p.DEF + p.TAC)) / 2;
  const def_phys =
    mean(defense.active_roster.map((p) => p.POS_attr + p.COM + p.AGG + p.STA + p.WR + p.STR)) / 6;
  const [, num_def] = count_positions(defense);
  let def_score = def_tech * 1.5 + def_phys * 0.8 + num_def * 0.5;

  const avg_pas_off = mean(offense.active_roster.map((p) => p.PAS));
  const avg_com_off = mean(offense.active_roster.map((p) => p.COM));
  const avg_def_def = mean(defense.active_roster.map((p) => p.DEF));
  const avg_tac_def = mean(defense.active_roster.map((p) => p.TAC));
  const avg_sta_def = mean(defense.active_roster.map((p) => p.STA));
  const avg_wr_def = mean(defense.active_roster.map((p) => p.WR));

  if (offense.tactical_style === "Possession")
    off_score *= 1.0 + 0.1 * ((avg_pas_off + avg_com_off) / 10.0);
  else if (offense.tactical_style === "Counterattack") off_score *= 0.8696;
  else if (offense.tactical_style === "Deep Block") off_score *= 0.8;

  if (defense.tactical_style === "Deep Block")
    def_score *= 1.0 + 0.25 * ((avg_def_def + avg_tac_def) / 10.0);
  else if (["High Press", "Gegenpress"].includes(defense.tactical_style))
    def_score *= 1.0 + 0.15 * ((avg_sta_def + avg_wr_def) / 10.0);
  else if (defense.tactical_style === "Chaos Attack") def_score *= 0.8333;

  off_score *= offense.momentum * env.pass_mod;
  def_score *= defense.momentum;

  let off_power = off_score ** 1.5;
  let def_power = def_score ** 1.5;

  off_power *= offense.active_roster.length / 9.0;
  def_power *= defense.active_roster.length / 9.0;

  const PRV = (off_power / (off_power + def_power)) * 100 + uniform(-1.0, 1.0);
  return Math.max(10.0, Math.min(PRV, 95.0));
}

// =============================================================================
// PHASE 2 & 3: ATTACK, FINISHING, SET-PIECES, & LOGGING
// =============================================================================
function select_set_piece_taker(team: EngineTeam): EnginePlayer | null {
  const eligible = team.active_roster.filter((p) => p.position !== "GK");
  if (!eligible.length) return null;
  return eligible.reduce((a, b) => (b.COM + b.FIN + b.SHO > a.COM + a.FIN + a.SHO ? b : a));
}

function execute_foul_set_piece(
  attacking_team: EngineTeam,
  defending_team: EngineTeam,
  current_TUP: number,
  match_tempo: number,
  env: MatchEnvironment,
  events_log: Log,
  log: Log,
  GOAL_MULTIPLIER: number,
  score_margin = 0
): number {
  const D = randint(1, 50);
  const time_consumed = uniform(0.3, 0.6) / match_tempo;
  let new_TUP = current_TUP + time_consumed;

  defending_team.fouls_committed += 1;
  const taker = select_set_piece_taker(attacking_team);
  if (!taker) return new_TUP;

  const gk_player = defending_team.active_roster.find((p) => p.position === "GK") || null;
  const gks_val = gk_player ? gk_player.rating : 5.0;

  const soft_cap_modifier = blowout_modifier(score_margin);

  if (D <= 16) {
    log.push(`[${f1(new_TUP)}'] PENALTY KICK! Foul inside the box by ${defending_team.name}!`);
    log.push(`   -> ${taker.name} steps up for ${attacking_team.name}...`);

    const skill_score = ((taker.FIN * 0.6 + taker.COM * 0.4) / Math.max(3.0, gks_val)) * 1.25;
    const luck_multiplier = uniform(0.9, 1.1);
    const PK_SP = Math.max(
      0.4,
      Math.min(
        skill_score * luck_multiplier * GOAL_MULTIPLIER * soft_cap_modifier * attacking_team.momentum,
        0.95
      )
    );

    attacking_team.shots += 1;
    attacking_team.xg_total += PK_SP;

    const roll = uniform(0, 1);
    if (roll <= PK_SP + 0.2) attacking_team.shots_on_target += 1;

    if (roll <= PK_SP) {
      taker.goals += 1;
      attacking_team.goals_scored += 1;
      if (gk_player) gk_player.goals_conceded += 1;
      log.push(
        `   -> GOAL!!! ${taker.name} converts! (${attacking_team.goals_scored}-${defending_team.goals_scored})`
      );
      events_log.push(`[${f1(new_TUP)}'] PENALTY GOAL! ${attacking_team.name} - ${taker.name}`);
      attacking_team.momentum = Math.min(1.15, attacking_team.momentum + 0.05);
      defending_team.momentum = Math.max(0.85, defending_team.momentum - 0.05);
    } else if (roll <= PK_SP + 0.05) {
      log.push(`   -> WOODWORK! ${taker.name} hits the post!`);
    } else if (roll <= PK_SP + 0.2) {
      if (gk_player) gk_player.saves += 1;
      log.push(`   -> SAVED! Exceptional reflex dive from the GK!`);
      defending_team.momentum = Math.min(1.15, defending_team.momentum + 0.03);
    } else {
      log.push(`   -> MISSED! Sent completely wide!`);
    }

    taker.fatigue = Math.min(100.0, taker.fatigue + 1.0 * (1.0 - get_stamina_reduction(taker)));
  } else if (D >= 17 && D <= 30) {
    log.push(`[${f1(new_TUP)}'] DIRECT FREE KICK for ${attacking_team.name} (${D} meters out).`);

    const skill_score =
      ((taker.FIN * 0.4 + taker.SHO * 0.3 + taker.COM * 0.3) / Math.max(3.0, gks_val)) *
      Math.max(0.2, 1.0 - (D - 17) * 0.05) *
      0.11;
    const luck_multiplier = uniform(0.85, 1.15);
    const FK_SP = Math.max(
      0.01,
      Math.min(
        skill_score * luck_multiplier * GOAL_MULTIPLIER * soft_cap_modifier * attacking_team.momentum,
        0.35
      )
    );

    attacking_team.shots += 1;
    attacking_team.xg_total += FK_SP;

    const roll = uniform(0, 1);
    if (roll <= FK_SP + 0.12) attacking_team.shots_on_target += 1;

    if (roll <= FK_SP) {
      taker.goals += 1;
      attacking_team.goals_scored += 1;
      if (gk_player) gk_player.goals_conceded += 1;
      log.push(
        `   -> GOAL!!! Magnificent curled free kick! (${attacking_team.goals_scored}-${defending_team.goals_scored})`
      );
      events_log.push(`[${f1(new_TUP)}'] FREE KICK GOAL! ${attacking_team.name} - ${taker.name}`);
      attacking_team.momentum = Math.min(1.15, attacking_team.momentum + 0.05);
      defending_team.momentum = Math.max(0.85, defending_team.momentum - 0.05);
    } else if (roll <= FK_SP + 0.03) {
      log.push(`   -> WOODWORK! Clips the crossbar!`);
    } else if (roll <= FK_SP + 0.12) {
      if (gk_player) gk_player.saves += 1;
      log.push(`   -> SAVED! Tipped over for a corner!`);
      defending_team.momentum = Math.min(1.15, defending_team.momentum + 0.03);
      new_TUP = execute_corner_kick(
        attacking_team, defending_team, new_TUP, match_tempo, env, events_log, log, GOAL_MULTIPLIER, score_margin
      );
    } else {
      log.push(`   -> Missed over the wall.`);
    }

    taker.fatigue = Math.min(100.0, taker.fatigue + 1.5 * (1.0 - get_stamina_reduction(taker)));
  } else {
    log.push(`[${f1(new_TUP)}'] Foul committed deep. ${attacking_team.name} restarts possession.`);
  }

  return new_TUP;
}

function execute_attack_phase(
  attacking_team: EngineTeam,
  defending_team: EngineTeam,
  current_TUP: number,
  match_tempo: number,
  env: MatchEnvironment,
  events_log: Log,
  log: Log,
  GOAL_MULTIPLIER: number,
  is_counter = false,
  is_corner = false,
  score_margin = 0
): number {
  if (is_corner)
    return execute_corner_kick(
      attacking_team, defending_team, current_TUP, match_tempo, env, events_log, log, GOAL_MULTIPLIER, score_margin
    );

  let time_consumed = uniform(0.4, 0.8) / match_tempo;
  if (is_counter) time_consumed *= 0.5;
  let new_TUP = current_TUP + time_consumed;

  const outfield_defenders = defending_team.active_roster.filter((p) => p.position !== "GK");
  const avg_def_ability = outfield_defenders.length
    ? mean(outfield_defenders.map((p) => p.DEF + p.TAC))
    : 5.0;
  const avg_pac_def = outfield_defenders.length ? mean(outfield_defenders.map((p) => p.PAC)) : 5.0;
  const avg_vis_def = outfield_defenders.length ? mean(outfield_defenders.map((p) => p.VIS)) : 5.0;

  const outfield_attackers = attacking_team.active_roster.filter((p) => p.position !== "GK");
  const avg_att_vis = outfield_attackers.length
    ? mean(outfield_attackers.map((p) => p.VIS + p.DRI))
    : 5.0;
  const avg_pac_att = outfield_attackers.length ? mean(outfield_attackers.map((p) => p.PAC)) : 5.0;

  let defense_block_chance = 35.0 + (avg_def_ability - avg_att_vis) * 5.0;

  if (defending_team.tactical_style === "Counterattack")
    defense_block_chance += 15.0 * ((avg_pac_def + avg_vis_def) / 10.0);
  if (is_counter) defense_block_chance -= 20.0 * ((avg_pac_att + avg_att_vis) / 10.0);

  defense_block_chance *= defending_team.active_roster.length / 9.0;

  defense_block_chance = Math.max(10.0, Math.min(defense_block_chance, 75.0));
  if (uniform(1, 100) <= defense_block_chance) {
    log.push(
      `[${f1(new_TUP)}'] BUILDUP: ${attacking_team.name} push forward, but the tactical structure cuts off the lane.`
    );
    return new_TUP;
  }

  const shooter = run_weighted_positional_lottery(attacking_team, true);
  if (!shooter) return new_TUP;

  log.push(
    `[${f1(new_TUP)}'] SHOT! ${shooter.name} (${shooter.position}) receives the ball and lets fly for ${attacking_team.name}!`
  );

  let xG = 0.35 * (1.0 + (shooter.FIN - 5) * 0.08 + (shooter.COM - 5) * 0.04 - shooter.fatigue / 150.0);
  if (attacking_team.tactical_style === "Chaos Attack")
    xG *= 1.0 + 0.2 * ((shooter.FIN + shooter.SHO) / 10.0);
  else if (attacking_team.tactical_style === "Possession") xG *= 0.9091;
  xG = Math.max(0.05, Math.min(xG, 0.8));

  const gk_player = defending_team.active_roster.find((p) => p.position === "GK") || null;
  const gks_val = gk_player ? gk_player.rating : 5.0;

  const defenders_on_pitch = defending_team.active_roster.filter((p) =>
    ["CB", "LB", "RB", "CDM"].includes(p.position)
  );
  const PRESS2 = defenders_on_pitch.length
    ? (mean(defenders_on_pitch.map((d) => d.DEF)) * 2.5) / 100.0
    : 0.125;

  let SP =
    xG *
    (1.0 +
      (shooter.FIN - 5) * 0.08 +
      (shooter.COM - 5) * 0.04 -
      PRESS2 -
      shooter.fatigue / 200.0 -
      (gks_val - 5) * 0.08) *
    GOAL_MULTIPLIER;

  SP *= attacking_team.momentum;
  SP *= blowout_modifier(score_margin);
  SP = Math.max(0.01, Math.min(SP, 0.95));

  attacking_team.shots += 1;
  attacking_team.xg_total += SP;
  const CPP = uniform(1, 100);
  const threshold = SP * 100;

  const is_on_target = CPP <= threshold + 5.0 + gks_val * 1.8;
  if (is_on_target || CPP <= threshold) attacking_team.shots_on_target += 1;

  if (CPP <= threshold) {
    shooter.goals += 1;
    attacking_team.goals_scored += 1;
    if (gk_player) gk_player.goals_conceded += 1;

    const assister = select_assister(attacking_team, shooter);
    let assist_log_text = "Unassisted";
    if (assister) {
      assister.assists += 1;
      assist_log_text = `Assist: ${assister.name}`;
    }

    log.push(`   -> GOAL!!! Clinical finish! (${attacking_team.goals_scored}-${defending_team.goals_scored})`);
    events_log.push(`[${f1(new_TUP)}'] GOAL! ${attacking_team.name} - ${shooter.name} (${assist_log_text})`);

    attacking_team.momentum = Math.min(1.15, attacking_team.momentum + 0.05);
    defending_team.momentum = Math.max(0.85, defending_team.momentum - 0.05);
  } else if (threshold < CPP && CPP <= threshold + 1.5) {
    log.push(`   -> WOODWORK! Ball rattles off the post!`);
  } else if (threshold + 1.5 < CPP && CPP <= threshold + 5.0) {
    log.push(`   -> NEAR MISS! Just wide of the target.`);
  } else if (threshold + 5.0 < CPP && CPP <= threshold + 5.0 + gks_val * 1.8) {
    if (gk_player) gk_player.saves += 1;
    log.push(`   -> SAVED! Corner kick awarded.`);
    defending_team.momentum = Math.min(1.15, defending_team.momentum + 0.03);
    new_TUP = execute_corner_kick(
      attacking_team, defending_team, new_TUP, match_tempo, env, events_log, log, GOAL_MULTIPLIER, score_margin
    );
  } else {
    log.push(`   -> BLOCKED cleanly by the defensive line.`);
  }

  let fatigue_drain = 1.0;
  if (["High Press", "Gegenpress"].includes(attacking_team.tactical_style)) {
    const fatigue_skill =
      (mean(outfield_attackers.map((p) => p.STA)) + mean(outfield_attackers.map((p) => p.WR))) / 10.0;
    fatigue_drain *= Math.max(0.8, 1.3 - 0.15 * fatigue_skill);
  }

  shooter.fatigue += fatigue_drain * (1.0 - get_stamina_reduction(shooter));
  return new_TUP;
}

function run_corner_kick_lottery(attacking_team: EngineTeam): EnginePlayer | null {
  const eligible = attacking_team.active_roster.filter((p) => p.position !== "GK");
  if (!eligible.length) return null;
  const weights: number[] = [];
  for (const p of eligible) {
    let w = p.AER * 2.5 + p.STR * 1.5 + p.rating * 0.5;
    if (["CB", "ST"].includes(p.position)) w *= 1.5;
    const perf = Math.max(0.1, 1.0 - p.fatigue / 140.0);
    weights.push(w * perf);
  }
  return weightedChoice(eligible, weights);
}

function execute_corner_kick(
  attacking_team: EngineTeam,
  defending_team: EngineTeam,
  current_TUP: number,
  match_tempo: number,
  env: MatchEnvironment,
  events_log: Log,
  log: Log,
  GOAL_MULTIPLIER: number,
  score_margin = 0
): number {
  log.push(`[${f1(current_TUP)}'] CORNER KICK for ${attacking_team.name}...`);
  attacking_team.corners_won += 1;

  if (
    uniform(1, 100) >
    50.0 + (get_top_aer_avg(attacking_team) - get_top_aer_avg(defending_team)) * 10
  ) {
    log.push("   -> CLEARED! The defense wins the header.");
    return current_TUP + 0.15 / match_tempo;
  }

  const shooter = run_corner_kick_lottery(attacking_team);
  if (!shooter) return current_TUP;

  const gk_player = defending_team.active_roster.find((p) => p.position === "GK") || null;

  let Header_SP =
    0.09 *
    ((shooter.AER * 1.5 + shooter.FIN + shooter.SHO) /
      Math.max(1.0, (gk_player ? gk_player.rating : 5.0) * 3.5)) *
    GOAL_MULTIPLIER;
  Header_SP *= attacking_team.momentum;
  Header_SP *= blowout_modifier(score_margin);
  Header_SP = Math.max(0.01, Math.min(Header_SP, 0.85));

  attacking_team.shots += 1;
  attacking_team.xg_total += Header_SP;

  const roll = uniform(1, 100);
  if (roll <= Header_SP * 100 + 15.0) attacking_team.shots_on_target += 1;

  if (roll <= Header_SP * 100) {
    shooter.goals += 1;
    attacking_team.goals_scored += 1;
    if (gk_player) gk_player.goals_conceded += 1;

    const assister = select_assister(attacking_team, shooter);
    const assist_log_text = assister ? `Assist: ${assister.name}` : "Unassisted";
    if (assister) assister.assists += 1;

    log.push(`   -> GOAL!!! A bullet header! (${attacking_team.goals_scored}-${defending_team.goals_scored})`);
    events_log.push(`[${f1(current_TUP)}'] GOAL! ${attacking_team.name} - ${shooter.name} (${assist_log_text})`);
    attacking_team.momentum = Math.min(1.15, attacking_team.momentum + 0.05);
    defending_team.momentum = Math.max(0.85, defending_team.momentum - 0.05);
  } else {
    log.push("   -> Header flies over the crossbar. Goal kick.");
  }

  return current_TUP + 0.15 / match_tempo;
}

function run_weighted_positional_lottery(
  attacking_team: EngineTeam,
  is_open_play = false
): EnginePlayer | null {
  const eligible = attacking_team.active_roster.filter((p) => p.position !== "GK");
  if (!eligible.length) return null;
  const weights: number[] = [];
  for (const p of eligible) {
    let base =
      p.position === "ST"
        ? 5.0
        : ["LW", "RW", "CAM"].includes(p.position)
        ? 3.0
        : ["CM", "CDM"].includes(p.position)
        ? 2.0
        : 1.0;

    if (is_open_play && attacking_team.tactical_style !== "Chaos Attack") {
      if (["CB", "LB", "RB", "LWB", "RWB"].includes(p.position)) base = 0.1;
    }

    const perf = Math.max(0.1, 1.0 - p.fatigue / 140.0);
    weights.push(base * p.rating * perf);
  }
  return weightedChoice(eligible, weights);
}

// =============================================================================
// FATIGUE & AI SUBSTITUTION MANAGER
// =============================================================================
function apply_5_minute_fatigue_drain(
  team_A: EngineTeam,
  team_B: EngineTeam,
  match_tempo: number,
  env: MatchEnvironment
): void {
  const base_f = (match_tempo <= 1.0 ? 2.0 : match_tempo <= 1.2 ? 3.0 : 4.0) * env.fatigue_mod;
  const pos_pf: Record<string, number> = {
    GK: 0, CB: 1, CDM: 1, ST: 1, FB: 2, LB: 2, RB: 2, CM: 2, CAM: 2, LW: 3, RW: 3,
  };
  const tact_pf: Record<string, number> = {
    "Deep Block": -1, Balanced: 0, Counterattack: 1, Possession: 1,
    "High Press": 2, Gegenpress: 3, "Chaos Attack": 4,
  };

  for (const team of [team_A, team_B]) {
    const t_val = tact_pf[team.tactical_style] ?? 0;
    for (const p of team.active_roster) {
      p.fatigue = Math.min(
        100.0,
        p.fatigue + (base_f + (pos_pf[p.position] ?? 1) + t_val) * (1.0 - get_stamina_reduction(p))
      );
    }
  }
}

function evaluate_substitutions(team: EngineTeam, TUP: number, goal_diff: number, log: Log): void {
  if (TUP < 45.0 || team.subs_made >= 5) return;

  if (TUP > 75.0) {
    if (goal_diff >= 2) {
      const attackers = team.active_roster.filter((p) => ["ST", "LW", "RW"].includes(p.position));
      const def_bench = team.bench.filter((p) => ["CB", "LB", "RB", "CDM"].includes(p.position));
      if (attackers.length && def_bench.length) {
        const out_p = attackers.reduce((a, b) => (b.fatigue > a.fatigue ? b : a));
        const in_p = def_bench[0];
        team.active_roster = team.active_roster.filter((x) => x !== out_p);
        team.bench = team.bench.filter((x) => x !== in_p);
        team.active_roster.push(in_p);
        team.subs_made += 1;
        log.push(`[${f1(TUP)}'] TACTICAL SUB (${team.name}): Protecting lead. ${in_p.name} ON, ${out_p.name} OFF.`);
        return;
      }
    } else if (goal_diff <= -2) {
      const defenders = team.active_roster.filter((p) => ["CB", "LB", "RB", "CDM"].includes(p.position));
      const att_bench = team.bench.filter((p) => ["ST", "LW", "RW", "CAM"].includes(p.position));
      if (defenders.length && att_bench.length) {
        const out_p = defenders.reduce((a, b) => (b.fatigue > a.fatigue ? b : a));
        const in_p = att_bench[0];
        team.active_roster = team.active_roster.filter((x) => x !== out_p);
        team.bench = team.bench.filter((x) => x !== in_p);
        team.active_roster.push(in_p);
        team.subs_made += 1;
        log.push(`[${f1(TUP)}'] TACTICAL SUB (${team.name}): Chasing game. ${in_p.name} ON, ${out_p.name} OFF.`);
        return;
      }
    }
  }

  for (const starter of [...team.active_roster]) {
    if (starter.position === "GK") continue;
    const candidates = team.bench.filter((b) => b.position === starter.position && !b.injured_severe);
    if (!candidates.length) continue;
    const sub = candidates[0];
    const EV_stay =
      2.0 *
      (0.22 * (1 + (starter.FIN - 5) * 0.035 - starter.fatigue / 250.0)) *
      (starter.yellow_cards > 0 ? Math.max(0.6, 1.0 - 0.005 * (90.0 - TUP)) : 1.0);
    const EV_sub = 2.0 * (0.22 * (1 + (sub.FIN - 5) * 0.035));
    if (EV_sub - EV_stay > 0.15) {
      team.active_roster = team.active_roster.filter((x) => x !== starter);
      team.bench = team.bench.filter((x) => x !== sub);
      team.active_roster.push(sub);
      team.subs_made += 1;
      log.push(`[${f1(TUP)}'] SMART SUB (${team.name}): ${sub.name} ON, ${starter.name} OFF.`);
      return;
    }
  }
}

// =============================================================================
// PENALTY SHOOTOUT SIMULATION (v7.1 playoff edition)
// =============================================================================
function run_penalty_shootout(team_A: EngineTeam, team_B: EngineTeam, log: Log): void {
  log.push("\n" + "=".repeat(50));
  log.push("      MATCH TIED! PROCEEDING TO A PENALTY SHOOTOUT");
  log.push("=".repeat(50));

  const gk_A = team_A.active_roster.find((p) => p.position === "GK") || null;
  const gk_B = team_B.active_roster.find((p) => p.position === "GK") || null;
  const gk_A_val = gk_A ? gk_A.rating : 5.0;
  const gk_B_val = gk_B ? gk_B.rating : 5.0;

  const t1_takers = team_A.active_roster.filter((p) => p.position !== "GK");
  const t2_takers = team_B.active_roster.filter((p) => p.position !== "GK");

  t1_takers.sort((a, b) => b.FIN * 0.6 + b.COM * 0.4 - (a.FIN * 0.6 + a.COM * 0.4));
  t2_takers.sort((a, b) => b.FIN * 0.6 + b.COM * 0.4 - (a.FIN * 0.6 + a.COM * 0.4));

  let t1_score = 0;
  let t2_score = 0;

  // 1. Standard Best-of-5 Rounds
  for (let r = 1; r <= 5; r++) {
    log.push(`\n--- Penalty Round ${r} ---`);

    if (t1_takers.length) {
      const taker_A = t1_takers[(r - 1) % t1_takers.length];
      const skill_A = ((taker_A.FIN * 0.6 + taker_A.COM * 0.4) / Math.max(3.0, gk_B_val)) * 1.25;
      if (uniform(0.9, 1.1) * skill_A > 0.65) {
        t1_score += 1;
        log.push(`  [GOAL] ${team_A.name}: ${taker_A.name} scores! (${t1_score} - ${t2_score})`);
      } else {
        log.push(`  [MISS/SAVE] ${team_A.name}: ${taker_A.name} fails to convert! (${t1_score} - ${t2_score})`);
      }
    }

    if (t1_score > t2_score + (5 - (r - 1))) break;
    if (t2_score > t1_score + (5 - r)) break;

    if (t2_takers.length) {
      const taker_B = t2_takers[(r - 1) % t2_takers.length];
      const skill_B = ((taker_B.FIN * 0.6 + taker_B.COM * 0.4) / Math.max(3.0, gk_A_val)) * 1.25;
      if (uniform(0.9, 1.1) * skill_B > 0.65) {
        t2_score += 1;
        log.push(`  [GOAL] ${team_B.name}: ${taker_B.name} scores! (${t1_score} - ${t2_score})`);
      } else {
        log.push(`  [MISS/SAVE] ${team_B.name}: ${taker_B.name} fails to convert! (${t1_score} - ${t2_score})`);
      }
    }

    if (t2_score > t1_score + (5 - r)) break;
    if (t1_score > t2_score + (5 - r)) break;
  }

  // 2. Strict Sudden Death Mode
  let sudden_death_round = 1;
  while (t1_score === t2_score) {
    log.push(`\n--- SUDDEN DEATH Round ${sudden_death_round} ---`);

    if (t1_takers.length) {
      const taker_A = t1_takers[(sudden_death_round + 4) % t1_takers.length];
      const skill_A = ((taker_A.FIN * 0.6 + taker_A.COM * 0.4) / Math.max(3.0, gk_B_val)) * 1.25;
      if (uniform(0.9, 1.1) * skill_A > 0.65) {
        t1_score += 1;
        log.push(`  [GOAL] ${team_A.name}: ${taker_A.name} scores! (${t1_score} - ${t2_score})`);
      } else {
        log.push(`  [MISS/SAVE] ${team_A.name}: ${taker_A.name} fails to convert! (${t1_score} - ${t2_score})`);
      }
    }

    if (t2_takers.length) {
      const taker_B = t2_takers[(sudden_death_round + 4) % t2_takers.length];
      const skill_B = ((taker_B.FIN * 0.6 + taker_B.COM * 0.4) / Math.max(3.0, gk_A_val)) * 1.25;
      if (uniform(0.9, 1.1) * skill_B > 0.65) {
        t2_score += 1;
        log.push(`  [GOAL] ${team_B.name}: ${taker_B.name} scores! (${t1_score} - ${t2_score})`);
      } else {
        log.push(`  [MISS/SAVE] ${team_B.name}: ${taker_B.name} fails to convert! (${t1_score} - ${t2_score})`);
      }
    }

    if (t1_score !== t2_score) break;
    sudden_death_round += 1;
  }

  // 3. Post final results to scoreboard cleanly
  log.push("\n" + "=".repeat(50));
  if (t1_score > t2_score) {
    log.push(`   ${team_A.name} WINS THE SHOOTOUT (${t1_score} - ${t2_score})!`);
    team_A.goals_scored += 1;
  } else {
    log.push(`   ${team_B.name} WINS THE SHOOTOUT (${t2_score} - ${t1_score})!`);
    team_B.goals_scored += 1;
  }
  log.push("=".repeat(50) + "\n");
}

// =============================================================================
// THE MASTER MATCH TIME SIMULATOR
// =============================================================================
export interface MatchResult {
  log: string[];
  homeGoals: number;
  awayGoals: number;
}

export function run_match(
  team_A: EngineTeam,
  team_B: EngineTeam,
  match_tempo = settings.defaultTempo,
  GOAL_MULTIPLIER = settings.goalMultiplier,
  playoff = false
): MatchResult {
  const log: Log = [];
  const env = makeEnvironment();

  let home_team_name: string;
  if (Math.random() < 0.5) {
    home_team_name = team_A.name;
    team_A.momentum = 1.05;
    team_B.momentum = 1.0;
  } else {
    home_team_name = team_B.name;
    team_B.momentum = 1.05;
    team_A.momentum = 1.0;
  }

  log.push(`\n==================================================`);
  log.push(` GENERATING PRE-MATCH SCOUTING DATA`);
  log.push(`==================================================`);

  choose_initial_tactic(team_A, team_B, log);
  choose_initial_tactic(team_B, team_A, log);

  const match_events: Log = [];

  log.push(`==================================================`);
  log.push(`KICKOFF: ${team_A.name} (${team_A.tactical_style}) VS ${team_B.name} (${team_B.tactical_style})`);
  log.push(`VENUE: ${home_team_name}'s Home Pitch`);
  log.push(`STADIUM CONDITIONS: ${env.weather_name} | Ref Strictness: ${env.ref_strictness}/10`);
  log.push(`==================================================`);

  let TUP = 0.0;
  let last_fatigue_update = 0.0;
  let last_change_A = 0.0;
  let last_change_B = 0.0;

  let [team_in_possession, defending_team] = weighted_possession_flip(team_A, team_B);

  while (TUP < 90.0) {
    if (team_A.active_roster.length < 6 || team_B.active_roster.length < 6) {
      log.push(`[${f1(TUP)}'] MATCH ABANDONED: Too few players remaining on the pitch.`);
      match_events.push(`[${f1(TUP)}'] MATCH ABANDONED (Insufficient Players)`);
      break;
    }

    if (TUP >= 45.0 && last_fatigue_update < 45.0) {
      log.push(`\n--- HALFTIME: ${team_A.name} ${team_A.goals_scored} - ${team_B.name} ${team_B.goals_scored} ---`);
      for (const t of [team_A, team_B]) {
        for (const p of t.active_roster) p.fatigue *= 0.9;
      }
      last_fatigue_update = 45.0;
      TUP = 45.0;
      [team_in_possession, defending_team] = weighted_possession_flip(team_A, team_B);
      continue;
    }

    const PRV = calculate_PRV(team_in_possession, defending_team, env);
    const R1 = uniform(1, 100);

    const prog_thresh = Math.max(1.0, PRV - 5.0);
    const recy_thresh = PRV + 5.0;
    const stop_thresh = Math.min(100.0, PRV + 15.0);

    const possession_margin = team_in_possession.goals_scored - defending_team.goals_scored;
    const cruise_control_multiplier = possession_margin >= 4 ? 1.3 : 1.0;

    if (R1 <= prog_thresh) {
      let time_spent = (0.9 / match_tempo) * cruise_control_multiplier;
      let is_style_counter = false;

      if (team_in_possession.tactical_style === "Counterattack") {
        time_spent *= 0.6;
        if (uniform(1, 100) <= mean(team_in_possession.active_roster.map((p) => p.PAC)) * 7) {
          is_style_counter = true;
        }
      }

      TUP += time_spent;
      TUP = execute_attack_phase(
        team_in_possession, defending_team, TUP, match_tempo, env, match_events, log, GOAL_MULTIPLIER,
        is_style_counter, false, possession_margin
      );
      [team_in_possession, defending_team] = weighted_possession_flip(team_A, team_B);
    } else if (R1 <= recy_thresh) {
      let time_spent: number;
      if (Math.random() < 0.35) {
        time_spent = (uniform(2.0, 3.5) / match_tempo) * cruise_control_multiplier;
      } else {
        time_spent = (1.3 / match_tempo) * cruise_control_multiplier;
      }
      team_in_possession.possession_ticks += time_spent;
      TUP += time_spent;
    } else if (R1 <= stop_thresh) {
      const time_spent = (0.8 / match_tempo) * cruise_control_multiplier;
      team_in_possession.possession_ticks += time_spent;
      TUP += time_spent;

      if (uniform(1, 100) <= 25.0) {
        TUP = execute_foul_set_piece(
          team_in_possession, defending_team, TUP, match_tempo, env, match_events, log, GOAL_MULTIPLIER, possession_margin
        );
      } else {
        execute_foul(defending_team, TUP, env, match_events, log);
      }
      [team_in_possession, defending_team] = weighted_possession_flip(team_A, team_B);
    } else {
      const time_spent = (0.8 / match_tempo) * cruise_control_multiplier;
      team_in_possession.possession_ticks += time_spent;
      TUP += time_spent;
      [team_in_possession, defending_team] = [defending_team, team_in_possession];

      if (team_in_possession.tactical_style === "Counterattack") {
        const new_possession_margin = team_in_possession.goals_scored - defending_team.goals_scored;
        const counter_trigger =
          (mean(team_in_possession.active_roster.map((p) => p.VIS)) +
            mean(team_in_possession.active_roster.map((p) => p.PAC))) /
          2.0;
        if (uniform(1, 100) <= counter_trigger * 8) {
          log.push(`[${f1(TUP)}'] INTERCEPTION! ${team_in_possession.name} launch a rapid counterattack!`);
          TUP = execute_attack_phase(
            team_in_possession, defending_team, TUP, match_tempo, env, match_events, log, GOAL_MULTIPLIER,
            true, false, new_possession_margin
          );
        } else {
          log.push(`[${f1(TUP)}'] Interception by ${team_in_possession.name}, but passing options are closed down.`);
        }
        [team_in_possession, defending_team] = weighted_possession_flip(team_A, team_B);
      }
    }

    if (TUP - last_fatigue_update >= 5.0) {
      apply_5_minute_fatigue_drain(team_A, team_B, match_tempo, env);
      check_injuries(team_A, TUP, env, match_events, log);
      check_injuries(team_B, TUP, env, match_events, log);

      for (const t of [team_A, team_B]) {
        if (t.momentum > 1.0) t.momentum = Math.max(1.0, t.momentum - 0.02);
        else if (t.momentum < 1.0) t.momentum = Math.min(1.0, t.momentum + 0.02);
      }

      const diff_A = team_A.goals_scored - team_B.goals_scored;
      evaluate_substitutions(team_A, TUP, diff_A, log);
      evaluate_substitutions(team_B, TUP, -diff_A, log);

      // Live in-match tactical shifts are gated by the Dynamic Tactics setting.
      // Capture each style BEFORE the call: evaluate_live_tactics mutates
      // team.tactical_style in place, so comparing its return value to the
      // (already-updated) team style would always match and disable the cooldown.
      if (settings.dynamicTactics) {
        const prev_style_A = team_A.tactical_style;
        if (evaluate_live_tactics(team_A, team_B, TUP, diff_A, last_change_A, log) !== prev_style_A)
          last_change_A = TUP;
        const prev_style_B = team_B.tactical_style;
        if (evaluate_live_tactics(team_B, team_A, TUP, -diff_A, last_change_B, log) !== prev_style_B)
          last_change_B = TUP;
      }

      last_fatigue_update += 5.0;
    }
  }

  // Match Finalization & Clean Sheet Assignments
  const gk_A = [...team_A.active_roster, ...team_A.bench].find((p) => p.position === "GK") || null;
  const gk_B = [...team_B.active_roster, ...team_B.bench].find((p) => p.position === "GK") || null;
  if (gk_A && team_B.goals_scored === 0) gk_A.clean_sheets += 1;
  if (gk_B && team_A.goals_scored === 0) gk_B.clean_sheets += 1;

  const total_ticks = team_A.possession_ticks + team_B.possession_ticks;
  const pos_A = total_ticks ? (team_A.possession_ticks / total_ticks) * 100 : 50.0;
  const pos_B = 100.0 - pos_A;

  log.push(`\n==================================================`);
  log.push(`FULL-TIME: ${team_A.name} ${team_A.goals_scored} - ${team_B.name} ${team_B.goals_scored}`);
  log.push(`==================================================`);
  log.push(`Shots (On Target):   ${team_A.shots}(${team_A.shots_on_target})   -   ${team_B.shots}(${team_B.shots_on_target})`);
  log.push(`Possession %:        ${pos_A.toFixed(0)}%     -   ${pos_B.toFixed(0)}%`);
  log.push(`Expected Goals (xG): ${f2(team_A.xg_total)}    -   ${f2(team_B.xg_total)}`);
  log.push(`Fouls / Corners:     ${team_A.fouls_committed} / ${team_A.corners_won}  -   ${team_B.fouls_committed} / ${team_B.corners_won}`);
  log.push(`--------------------------------------------------`);
  log.push("Match Events:");
  for (const event of match_events) log.push(event);
  if (!match_events.length) log.push("No major events recorded.");

  log.push("\n--------------------------------------------------");
  log.push("Player Condition Overview:");
  for (const team of [team_A, team_B]) {
    log.push(`\n--- ${team.name} ---`);
    const played = [...team.active_roster, ...team.bench].filter(
      (p) => p.fatigue > 0.0 || p.goals > 0 || p.yellow_cards > 0 || p.saves > 0
    );
    for (const p of played) {
      const cards: string[] = [];
      if (p.yellow_cards > 0) cards.push(`YCx${p.yellow_cards}`);
      if (p.red_card) cards.push("RC");
      const card_str = cards.length ? ` [${cards.join(", ")}]` : "";

      let stats_str = "";
      if (p.position === "GK") {
        const cs_str = p.clean_sheets > 0 ? ` CS: ${p.clean_sheets}` : "";
        stats_str = ` | Saves: ${p.saves} GC: ${p.goals_conceded}${cs_str}`;
      } else {
        stats_str = p.goals > 0 || p.assists > 0 ? ` | G: ${p.goals} A: ${p.assists}` : "";
      }

      log.push(
        `${padR(p.name, 18)} (${padR(p.position, 3)})${stats_str} | Fatigue: ${p.fatigue.toFixed(1)}${card_str}${
          p.injured_severe ? " [INJURED]" : ""
        }`
      );
    }
  }

  // === PENALTY SHOOTOUT TRIGGER (playoff matches only, when enabled) ===
  if (playoff && settings.playoffPenalties && team_A.goals_scored === team_B.goals_scored) {
    run_penalty_shootout(team_A, team_B, log);
  }

  return { log, homeGoals: team_A.goals_scored, awayGoals: team_B.goals_scored };
}
