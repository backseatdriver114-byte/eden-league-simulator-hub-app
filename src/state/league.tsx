// League state: types, Cloud + localStorage persistence, initialization, and actions.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { RAW_TEAMS } from "@/data/rosters";
import { INITIAL_BUDGETS } from "@/data/budgets";
import { INITIAL_SCHEDULE } from "@/data/schedule";
import { buildEngineTeam, run_match } from "@/engine/engine";
import { computeOverall } from "@/lib/ratings";
import { computeStartingAge, ageOnePlayer } from "@/lib/aging";
import { buildMatchPayload, type MatchPayload } from "@/lib/match-payload";
import type { VersionData } from "@/lib/league-export";
import {
  applyTeamEvent, applyPlayerEvent, moraleScaledAttrs, MORALE_BASELINE,
  clampMorale, carryOverMorale, drainSackedTeams, triggerManagerSack,
} from "@/lib/morale";
import { buildManagers, type ManagerRecord } from "@/data/managers";
import {
  generateTradeProposals, parseBudget, formatBudget, type TradeProposal,
} from "@/lib/trades";
import { initializeContracts, calculateMarketValue, payrollOf, runContractCycle as runCycle, type ContractAction } from "@/lib/contracts";
import { applySettings, getSettings, DEFAULT_SETTINGS, settings as engineSettings, isManualSimTeam, isContractExempt, type EngineSettings } from "@/lib/engine-settings";
import { nextRelation, clampRespect } from "@/lib/relations";

const STORAGE_KEY = "eden_league_state_v6";
const LEGACY_STORAGE_KEYS = ["eden_league_state_v5", "eden_league_state_v4", "eden_league_state_v3", "eden_league_state_v2", "eden_league_state_v1"];

// Transfer window: the automatic trade engine only runs at the end of regular
// season match weeks (1–12).
export const TRANSFER_WINDOW_LAST_WEEK = 12;
// A weeks-out value at or above this is treated as "out for the rest of the season".
export const SEASON_ENDING_WEEKS = 99;
// Disciplinary thresholds.
const YELLOW_WINDOW_WEEKS = 2; // 2 yellows within this many weeks => suspension
const YELLOW_SUSPENSION = 1;
const RED_SUSPENSION = 2;

export const DEFAULT_FORMATION = "3-3-2";
const MAX_UNDO = 1000;

export const ATTR_KEYS = [
  "rating", "FIN", "SHO", "PAS", "VIS", "DRI", "PAC", "STA",
  "DEF", "TAC", "POS_attr", "COM", "WR", "AGG", "STR", "AER",
] as const;
export type AttrKey = (typeof ATTR_KEYS)[number];

export interface LeaguePlayer {
  name: string;
  position: string;
  starter: boolean;
  age: number;
  morale: number; // 0–100, baseline 50
  injuryWeeks: number; // 0 = healthy; SEASON_ENDING_WEEKS = out for season
  suspensionWeeks: number; // 0 = not suspended
  // Slot the player should reclaim when they recover. null = not out / no reservation;
  // >= 0 = the formation slot index they started in; -1 = they were a bench player.
  reservedSlot: number | null;
  yellowLog: number[]; // weeks in which unpunished yellows were received
  salary: number; // annual salary in $M (contract layer)
  contractYears: number; // years remaining on contract
  forSale?: boolean; // club has publicly listed the player — attracts more buyers
  // Lazily-generated agent identity used by the Contracts-suite renegotiation.
  // Created the first time a user-controlled club opens contract talks for this
  // player; persisted thereafter so personality stays consistent across deals.
  agent?: { name: string; personality: string; tolerance: string };
  rating: number; FIN: number; SHO: number; PAS: number; VIS: number; DRI: number;
  PAC: number; STA: number; DEF: number; TAC: number; POS_attr: number; COM: number;
  WR: number; AGG: number; STR: number; AER: number;
}

export interface LeagueTeamColors {
  primary?: string | null;
  secondary?: string | null;
  tertiary?: string | null;
}

export interface LeagueTeam {
  name: string;
  tactical_style: string;
  budget: string;
  morale: number; // 0–100, baseline 50
  formation: string; // e.g. "3-3-2" (outfield rows, GK implicit; digits sum to 8)
  lineup: string[]; // ordered slot assignments (player names; "" = empty)
  players: LeaguePlayer[];
  salaryBudget: number; // payroll cap space (set to the global hard cap)
  // Optional per-team branding overrides. When absent, the app falls back to
  // the seed defaults in `lib/team-branding.ts` keyed by team name.
  logo?: string | null; // absolute URL or data URL of the crest image
  colors?: LeagueTeamColors;
}

export interface MatchRecord {
  homeGoals: number;
  awayGoals: number;
  method: "SIM" | "MANUAL";
}

export interface FixtureEntry {
  id: string;
  week: number;
  home: string;
  away: string;
}

export interface PlayoffMatch {
  id: string;
  round: number; // 1 = Wild Card, 2 = Divisional, 3 = Semifinal, 4 = Final
  homeSeed: number;
  awaySeed: number;
  home: string;
  away: string;
  result?: MatchRecord;
}

export interface PlayoffsState {
  seeds: string[]; // top 14, index 0 = seed 1
  rounds: PlayoffMatch[][]; // rounds[0] = Wild Card, etc.
  champion?: string;
}

// ---------------- Draft ----------------
// A tradeable draft pick. Owned by a club; ownership changes when traded.
// The pick's board slot/order is computed at draft time from reverse standings.
export interface DraftPick {
  id: string;
  season: number; // the draft (offseason) season these picks belong to
  round: 1 | 2;
  originalTeam: string; // club the pick originally belongs to
  owner: string; // current owner (changes on trade)
}

// A selection made during a live draft.
export interface DraftSelection {
  pickId: string;
  prospectName: string;
  team: string; // the owner who selected
}

// Live draft state (the prospect pool + board). Reset each offseason.
export interface DraftState {
  season: number; // season this draft is conducting
  prospects: LeaguePlayer[]; // the prospect pool
  started: boolean; // board generated, drafting underway
  order: string[]; // ordered list of pick ids (round 1 then round 2, reverse standings)
  currentPickIndex: number; // 0-based index into order
  selections: DraftSelection[];
  complete: boolean;
}

export interface LeagueState {
  currentWeek: number;
  season: number;
  teamOrder: string[];
  teams: Record<string, LeagueTeam>;
  fixtures: FixtureEntry[];
  results: Record<string, MatchRecord>;
  payloads: Record<string, MatchPayload>; // keyed by fixture / playoff match id
  playoffs?: PlayoffsState;
  tradeProposals: TradeProposal[];
  // Per-club manager identity + negotiation personality. User-controlled
  // (contract-exempt) clubs carry the "USER CONTROLLED" personality.
  managers: Record<string, ManagerRecord>;
  undoStack: string[]; // serialized prior states (universal undo)
  redoStack: string[]; // serialized undone states (universal redo)
  salaryCap: number; // league-wide hard salary cap ($M)
  freeAgents: LeaguePlayer[]; // unattached players available for free signing
  contractsInitialized: boolean; // first-boot compliance setup complete
  settings?: EngineSettings; // editable engine tuning knobs (Settings suite)
  draftPicks: DraftPick[]; // tradeable picks for the upcoming draft (always 48)
  draft?: DraftState; // live draft pool/board (offseason)
  // Manager Relations: how a user-controlled team's manager feels about each
  // OTHER (AI) manager. Keyed by AI team name; value is 0-100 (50 = neutral).
  // Single relationship per AI manager, shared across all user clubs (since
  // the user is one person in real life).
  relations?: Record<string, number>;
  // Public press conference archive. Every Q/A from every press conference
  // is recorded here so AI features (future press questions, news articles,
  // DM replies) can reference what the manager actually said on the record.
  pressArchive?: PressArchiveEntry[];
  // Media Article archive. Every article the Newsroom writes is auto-filed
  // here so users can revisit past coverage and (later) so AI features can
  // reference the league's own news history.
  articleArchive?: ArticleArchiveEntry[];
  // Public league events (managerial sackings, hires). Small notes the
  // press/AI can reference. Capped to a rolling window.
  leagueEvents?: LeagueEvent[];
}

export interface PressArchiveEntry {
  id: string;
  season: number;
  week: number;
  team: string;          // club holding the conference
  managerName: string;   // speaker
  context: "general" | "pre" | "post";
  question: string;
  answer: string;
  summary?: string;      // AI-scored one-clause headline (optional)
  targets?: { kind: "team" | "player" | "manager"; team?: string; name?: string }[];
  createdAt: string;     // ISO timestamp
}

export interface ArticleArchiveEntry {
  id: string;
  season: number;
  week: number;
  kind: "postgame" | "roundup" | "drama";
  title: string;         // first line / headline extract
  body: string;          // full markdown article
  focus?: string;        // reader-supplied angle, if any
  createdAt: string;     // ISO timestamp
}

export interface LeagueEvent {
  id: string;
  season: number;
  week: number;
  kind: "manager_fired" | "manager_hired" | "fire_and_hire";
  team: string;
  detail: string;        // human-readable summary
  createdAt: string;
}

export interface StandingRow {
  rank: number;
  team: string;
  pld: number; w: number; d: number; l: number;
  gf: number; ga: number; gd: number; pts: number;
}

// ---------------- Player leaderboards ----------------
export interface ScorerRow { team: string; name: string; goals: number; assists: number; }
export interface AssistRow { team: string; name: string; assists: number; goals: number; }
export interface KeeperRow { team: string; name: string; cleanSheets: number; conceded: number; apps: number; }
export interface Leaderboards { scorers: ScorerRow[]; assists: AssistRow[]; keepers: KeeperRow[]; }

// ---------------- Helpers ----------------
export function isPlayerOut(p: LeaguePlayer): boolean {
  return p.injuryWeeks > 0 || p.suspensionWeeks > 0;
}

export type PosGroup = "GK" | "DF" | "MF" | "ST";
const DF_POS = ["CB", "LB", "RB", "LWB", "RWB", "FB"];
const MF_POS = ["CDM", "CM", "CAM", "LM", "RM"];
const ST_POS = ["ST", "CF", "LW", "RW", "WINGER"];

export function positionGroup(pos: string): PosGroup {
  const p = (pos || "").toUpperCase().trim();
  if (p === "GK") return "GK";
  if (DF_POS.includes(p)) return "DF";
  if (MF_POS.includes(p)) return "MF";
  if (ST_POS.includes(p)) return "ST";
  return "MF";
}

// A formation is any sequence of outfield-row sizes whose digits sum to 8
// (9 minus the goalkeeper). e.g. "3-3-2", "4-4", "2-3-2-1", "1-2-3-2".
export function parseFormation(f: string): number[] {
  const parts = (f || "").split("-").map((n) => parseInt(n.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
  if (parts.length >= 1 && parts.reduce((s, n) => s + n, 0) === 8) return parts;
  return [3, 3, 2];
}

export function isValidFormation(f: string): boolean {
  const parts = (f || "").split("-").map((n) => parseInt(n.trim(), 10));
  return parts.length >= 1 && parts.every((n) => !isNaN(n) && n > 0) && parts.reduce((s, n) => s + n, 0) === 8;
}

// Slots: a GK slot (line 0) plus one generic outfield slot per formation unit.
// Each slot now carries an `idealPosition` label (CB / LB / CM / ST / …)
// derived from the row (defense/midfield/attack) and lateral offset so
// auto-fill and formation-change re-mapping can place players by ROLE.
export interface LineupSlot { group: PosGroup | "OUT"; label: string; line: number; idealPosition: string; }

// Position labels for each slot in a given formation row, left → right.
function idealPositionsForRow(rowIdx: number, count: number, totalOutfieldRows: number): string[] {
  const isFirst = rowIdx === 0; // back line
  const isLast = rowIdx === totalOutfieldRows - 1; // front line
  const out: string[] = [];
  if (isFirst) {
    if (count === 1) return ["CB"];
    if (count === 2) return ["LB", "RB"];
    if (count === 3) return ["LB", "CB", "RB"];
    if (count === 4) return ["LB", "CB", "CB", "RB"];
    out.push("LB");
    for (let i = 0; i < count - 2; i++) out.push("CB");
    out.push("RB");
    return out;
  }
  if (isLast) {
    if (count === 1) return ["ST"];
    if (count === 2) return ["LW", "RW"];
    if (count === 3) return ["LW", "ST", "RW"];
    out.push("LW");
    for (let i = 0; i < count - 2; i++) out.push("ST");
    out.push("RW");
    return out;
  }
  // Middle row(s): choose CDM (near back), CM (middle), CAM (near front).
  const rel = totalOutfieldRows <= 2 ? 0.5 : rowIdx / (totalOutfieldRows - 1);
  const centerPos = rel < 0.4 ? "CDM" : rel > 0.6 ? "CAM" : "CM";
  if (count === 1) return [centerPos];
  if (count === 2) return [centerPos, centerPos];
  if (count === 3) return ["LM", centerPos, "RM"];
  if (count === 4) return ["LM", centerPos, centerPos, "RM"];
  out.push("LM");
  for (let i = 0; i < count - 2; i++) out.push(centerPos);
  out.push("RM");
  return out;
}

export function buildLineupSlots(formation: string): LineupSlot[] {
  const rows = parseFormation(formation);
  const slots: LineupSlot[] = [{ group: "GK", label: "GK", line: 0, idealPosition: "GK" }];
  rows.forEach((count, r) => {
    const ideals = idealPositionsForRow(r, count, rows.length);
    for (let i = 0; i < count; i++) {
      slots.push({ group: "OUT", label: `${r + 1}.${i + 1}`, line: r + 1, idealPosition: ideals[i] ?? "CM" });
    }
  });
  return slots;
}

// Pick a sensible default lineup that RESPECTS each player's listed position.
// Greedy best-fit: iterate slots in order of specificity (GK → wide roles →
// specialised centers → generic CM/ST) and for each slot pick the highest-
// scoring unused, healthy player, where score blends positional fit (dominant)
// with rating (tiebreaker). Falls back to any healthy player, then any player,
// so no slot is ever left empty when a warm body is available.
export function buildDefaultLineup(players: LeaguePlayer[], formation: string): string[] {
  const slots = buildLineupSlots(formation);
  return assignPlayersToSlots(slots, players, []);
}

// Slot fill priority: GK first, then the roles hardest to substitute (fullbacks,
// wingers, out-and-out wide mids), then specialised centres, then generic ones.
const SLOT_PRIORITY: Record<string, number> = {
  GK: 0, LB: 1, RB: 1, LWB: 1, RWB: 1, LW: 2, RW: 2, LM: 3, RM: 3,
  CDM: 4, CAM: 4, CB: 5, ST: 6, CM: 7,
};
function slotPriority(pos: string): number {
  return SLOT_PRIORITY[(pos || "").toUpperCase()] ?? 8;
}

// Greedy position-aware slot assignment. `preferred` lets a caller pass names
// that should be prioritised for consideration first (used by formation
// remap to preserve current starters).
function assignPlayersToSlots(
  slots: LineupSlot[],
  players: LeaguePlayer[],
  preferred: string[],
): string[] {
  const lineup: string[] = slots.map(() => "");
  const used = new Set<string>();
  const order = slots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => slotPriority(a.s.idealPosition) - slotPriority(b.s.idealPosition));

  const scorePlayerForSlot = (p: LeaguePlayer, slot: LineupSlot): number => {
    const fit = positionSimilarity(slot.idealPosition, p.position);
    const boost = preferred.includes(p.name) ? 0.5 : 0;
    // Position fit dominates; rating breaks ties between similarly-fit players.
    return fit * 10 + boost + p.rating * 0.5;
  };

  for (const { s, i } of order) {
    let pick: LeaguePlayer | undefined;
    let pickScore = -Infinity;
    for (const p of players) {
      if (used.has(p.name)) continue;
      if (isPlayerOut(p)) continue;
      // GK slots demand a keeper (positionSimilarity already returns 0 across the GK gap).
      if (s.group === "GK" && positionGroup(p.position) !== "GK") continue;
      if (s.group !== "GK" && positionGroup(p.position) === "GK") continue;
      const sc = scorePlayerForSlot(p, s);
      if (sc > pickScore) { pickScore = sc; pick = p; }
    }
    // Fallbacks so slots don't stay empty for depleted squads.
    if (!pick) {
      pick = players.find((p) => !used.has(p.name) && !isPlayerOut(p));
    }
    if (!pick) pick = players.find((p) => !used.has(p.name));
    if (pick) { used.add(pick.name); lineup[i] = pick.name; }
  }
  return lineup;
}

// Formation change: preserve current starters as much as possible, then let
// them settle into the closest matching role in the new formation. Reserves
// stay on the bench unless a starter has no natural fit (in which case a
// better-fit bench player can be promoted).
export function remapLineupForFormation(
  players: LeaguePlayer[],
  oldLineup: string[],
  newFormation: string,
): string[] {
  const newSlots = buildLineupSlots(newFormation);
  const starterNames = oldLineup.filter(Boolean);
  const starters = players.filter((p) => starterNames.includes(p.name));
  const bench = players.filter((p) => !starterNames.includes(p.name));
  // Try to place only current starters first — this is what preserves the
  // "same 9 on the pitch" feel across a formation tweak.
  const pool = [...starters, ...bench]; // starters get first crack via the preferred boost
  return assignPlayersToSlots(newSlots, pool, starterNames);
}

// Re-derive each player's `starter` flag from the team lineup.
export function syncStarters(team: LeagueTeam): LeagueTeam {
  const inLineup = new Set(team.lineup.filter(Boolean));
  return {
    ...team,
    players: team.players.map((p) => ({ ...p, starter: inLineup.has(p.name) })),
  };
}

// ---------------- Best-fit replacement selection ----------------
// Each position lives on a simple pitch map: x = lateral channel (left -1,
// centre 0, right +1) and y = vertical line (GK 0 → striker 5). Lateral drift is
// cheap, moving up/down the pitch is expensive — an RW slides to LW far more
// naturally than an RW drops to CB. A keeper is unique: GK↔outfield never fits.
const POS_COORD: Record<string, [number, number]> = {
  GK: [0, 0],
  CB: [0, 1], LB: [-1, 1], RB: [1, 1], LWB: [-1, 1.5], RWB: [1, 1.5], FB: [0, 1],
  CDM: [0, 2], CM: [0, 3], LM: [-1, 3], RM: [1, 3], CAM: [0, 4],
  ST: [0, 5], CF: [0, 4.5], LW: [-1, 5], RW: [1, 5], WINGER: [0.8, 5],
};
function coordFor(pos: string): [number, number] {
  return POS_COORD[(pos || "").toUpperCase().trim()] ?? [0, 3];
}
// Position fit in [0,1]: 1 = identical role, 0 = totally unrelated (or GK gap).
export function positionSimilarity(a: string, b: string): number {
  const aGK = (a || "").toUpperCase().trim() === "GK";
  const bGK = (b || "").toUpperCase().trim() === "GK";
  if (aGK !== bGK) return 0; // outfielders can't deputise in goal, and vice versa
  const [ax, ay] = coordFor(a);
  const [bx, by] = coordFor(b);
  const dx = (ax - bx) * 0.5; // lateral drift weighted lightly
  const dy = (ay - by) * 2.0; // vertical (line) drift weighted heavily
  const d = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, 1 - d / 10); // 10 = GK↔striker, the widest realistic gap
}
// Pick the healthy bench player who best replaces an injured starter. Score
// blends positional fit (dominant for big role gaps) with overall rating (the
// tie-breaker between players in nearby roles) — so a stronger LW beats a weaker
// RW for an RW slot, but a star CB never poaches that same RW slot.
export function bestReplacement(
  injured: LeaguePlayer,
  candidates: LeaguePlayer[]
): LeaguePlayer | undefined {
  const healthy = candidates.filter((c) => !isPlayerOut(c));
  if (!healthy.length) return undefined;
  const score = (c: LeaguePlayer) =>
    positionSimilarity(injured.position, c.position) * 10 + c.rating * 1.2;
  return [...healthy].sort((a, b) => score(b) - score(a))[0];
}

// Mark a player as out (injured/suspended): remember the formation slot they
// were starting in (or -1 if they were a bench player) and vacate that slot, then
// auto-promote the best-fit healthy reserve into it. The reservation is captured
// only once, on the first match/edit that benches them, so chained cards don't
// overwrite it.
export function markReserved(team: LeagueTeam, playerName: string): LeagueTeam {
  const slot = team.lineup.indexOf(playerName);
  const injured = team.players.find((p) => p.name === playerName);
  const players = team.players.map((p) => {
    if (p.name !== playerName) return p;
    if (p.reservedSlot != null) return p; // reservation already captured
    return { ...p, reservedSlot: slot >= 0 ? slot : -1 };
  });
  let lineup = slot >= 0 ? team.lineup.map((n, i) => (i === slot ? "" : n)) : team.lineup;
  // Auto-fill the vacated slot with the best-fit healthy bench player.
  if (slot >= 0 && injured) {
    const inLineup = new Set(lineup.filter(Boolean));
    const bench = players.filter(
      (p) => p.name !== playerName && !inLineup.has(p.name) && !isPlayerOut(p)
    );
    const replacement = bestReplacement(injured, bench);
    if (replacement) lineup = lineup.map((n, i) => (i === slot ? replacement.name : n));
  }
  return syncStarters({ ...team, players, lineup });
}

// Restore a recovered player to the exact slot they held before going out. If
// that slot is now occupied by a replacement, the replacement is bumped to the
// bench. Bench players (reservedSlot === -1) simply return to the bench.
export function restoreReserved(team: LeagueTeam, playerName: string): LeagueTeam {
  const player = team.players.find((p) => p.name === playerName);
  const slot = player?.reservedSlot ?? null;
  let lineup = team.lineup;
  if (slot != null && slot >= 0) {
    lineup = lineup.map((n) => (n === playerName ? "" : n)); // avoid duplicates
    if (slot < lineup.length) {
      // The original starting slot still exists — reclaim it.
      lineup = lineup.map((n, i) => (i === slot ? playerName : n));
    } else {
      // Formation shrank and the exact slot is gone: fall back to the first
      // empty starting slot so a returning starter isn't silently dropped.
      const empty = lineup.findIndex((n) => !n);
      if (empty >= 0) lineup = lineup.map((n, i) => (i === empty ? playerName : n));
    }
  }
  const players = team.players.map((p) =>
    p.name === playerName ? { ...p, reservedSlot: null } : p
  );
  return syncStarters({ ...team, players, lineup });
}


export function blankPlayer(): LeaguePlayer {
  const base: LeaguePlayer = {
    name: "New Player", position: "CM", starter: false,
    age: 24, morale: MORALE_BASELINE,
    injuryWeeks: 0, suspensionWeeks: 0, reservedSlot: null, yellowLog: [],
    salary: 5.0, contractYears: 2,
    rating: 5.0, FIN: 5.0, SHO: 5.0, PAS: 5.0, VIS: 5.0, DRI: 5.0,
    PAC: 5.0, STA: 5.0, DEF: 5.0, TAC: 5.0, POS_attr: 5.0, COM: 5.0,
    WR: 5.0, AGG: 5.0, STR: 5.0, AER: 5.0,
  };
  return { ...base, rating: computeOverall(base) };
}

// A 1.0-rated youth academy fill-in to legally complete a depleted squad.
export function youthPlayer(): LeaguePlayer {
  const base: LeaguePlayer = {
    name: "Youth Academy Call-up", position: "CM", starter: true,
    age: 18, morale: MORALE_BASELINE,
    injuryWeeks: 0, suspensionWeeks: 0, reservedSlot: null, yellowLog: [],
    salary: 1.0, contractYears: 1,
    rating: 1.0, FIN: 1.0, SHO: 1.0, PAS: 1.0, VIS: 1.0, DRI: 1.0,
    PAC: 1.0, STA: 1.0, DEF: 1.0, TAC: 1.0, POS_attr: 1.0, COM: 1.0,
    WR: 1.0, AGG: 1.0, STR: 1.0, AER: 1.0,
  };
  return { ...base, rating: computeOverall(base) };
}

// ---------------- Draft ----------------
export const DRAFT_ROUNDS = 2;
export const DRAFT_POOL_SIZE = 48; // 24 teams × 2 rounds

// Build the full set of tradeable picks for a draft season — 2 rounds, every
// club holds its own pick to start. Order/slot is computed at draft time.
export function buildDraftPicks(teamOrder: string[], season: number): DraftPick[] {
  const picks: DraftPick[] = [];
  for (let round = 1 as 1 | 2; round <= DRAFT_ROUNDS; round = (round + 1) as 1 | 2) {
    teamOrder.forEach((team, i) => {
      picks.push({
        id: `pick-s${season}-r${round}-${i}`,
        season,
        round,
        originalTeam: team,
        owner: team,
      });
    });
  }
  return picks;
}

// A fresh prospect for the draft pool. Health/morale fields exist (player shape)
// but are unused in the draft UI; contract is the fixed rookie deal applied on
// selection.
export function prospectPlayer(): LeaguePlayer {
  const base: LeaguePlayer = {
    name: "NEW PROSPECT PLAYER", position: "CM", starter: false,
    age: 19, morale: MORALE_BASELINE,
    injuryWeeks: 0, suspensionWeeks: 0, reservedSlot: null, yellowLog: [],
    salary: 2.0, contractYears: 2,
    rating: 6.0, FIN: 6.0, SHO: 6.0, PAS: 6.0, VIS: 6.0, DRI: 6.0,
    PAC: 6.0, STA: 6.0, DEF: 6.0, TAC: 6.0, POS_attr: 6.0, COM: 6.0,
    WR: 6.0, AGG: 6.0, STR: 6.0, AER: 6.0,
  };
  return { ...base, rating: computeOverall(base) };
}

// Exponential injury duration: 1 week is the most common outcome, escalating
// up to a rare season-ending blow. Extension probability is 0.65 (was 0.5) so
// 2- and 3-week injuries appear noticeably more often without diluting the
// rarity of the long-term blow. Only applied to players carried off.
export function rollInjuryWeeks(): number {
  let weeks = 1;
  while (Math.random() < 0.65 && weeks < 14) weeks++;
  return weeks >= 12 ? SEASON_ENDING_WEEKS : weeks;
}

// ---------------- Initialization ----------------
export function initState(): LeagueState {
  const teams: Record<string, LeagueTeam> = {};
  const teamOrder: string[] = [];
  for (const t of RAW_TEAMS) {
    teamOrder.push(t.name);
    const players = t.roster.map((p, i) => {
      const player: LeaguePlayer = {
        name: p.name,
        position: p.position,
        starter: i < 9,
        age: 25,
        morale: MORALE_BASELINE,
        injuryWeeks: 0,
        suspensionWeeks: 0,
        reservedSlot: null,
        yellowLog: [],
        salary: 0,
        contractYears: 0,
        rating: p.rating, FIN: p.FIN, SHO: p.SHO, PAS: p.PAS, VIS: p.VIS, DRI: p.DRI,
        PAC: p.PAC, STA: p.STA, DEF: p.DEF, TAC: p.TAC, POS_attr: p.POS_attr, COM: p.COM,
        WR: p.WR, AGG: p.AGG, STR: p.STR, AER: p.AER,
      };
      const withAge = { ...player, age: computeStartingAge(player) };
      return { ...withAge, rating: computeOverall(withAge) };
    });
    const lineup = buildDefaultLineup(players, DEFAULT_FORMATION);
    teams[t.name] = syncStarters({
      name: t.name,
      tactical_style: t.tactical_style,
      budget: INITIAL_BUDGETS[t.name] ?? "$0M",
      morale: MORALE_BASELINE,
      formation: DEFAULT_FORMATION,
      lineup,
      players,
      salaryBudget: 0,
    });
  }
  const fixtures: FixtureEntry[] = INITIAL_SCHEDULE.map((f, i) => ({
    id: `w${f.week}-m${i}`,
    week: f.week,
    home: f.home,
    away: f.away,
  }));
  // First-time compliance: pay every player their market value, assign a 1–4yr
  // deal and declare the highest club payroll as the global Hard Salary Cap.
  const { teams: capTeams, salaryCap } = initializeContracts(teams, teamOrder);
  return {
    currentWeek: 1, season: 1, teamOrder, teams: capTeams, fixtures,
    results: {}, payloads: {}, tradeProposals: [], undoStack: [], redoStack: [],
    salaryCap, freeAgents: [], contractsInitialized: true,
    managers: buildManagers(teamOrder),
    settings: { ...DEFAULT_SETTINGS, contractExemptTeams: [...DEFAULT_SETTINGS.contractExemptTeams] },
    draftPicks: buildDraftPicks(teamOrder, 1),
  };
}

// Ensure migrated/older state has all required fields.
function normalize(state: LeagueState): LeagueState {
  // Per-player field backfill, shared by team rosters and the free-agent pool so
  // an old/partial save can never surface a player missing a required field.
  const normalizePlayer = (p: LeaguePlayer): LeaguePlayer => {
    const player: LeaguePlayer = {
      ...p,
      injuryWeeks: p.injuryWeeks ?? 0,
      suspensionWeeks: p.suspensionWeeks ?? 0,
      reservedSlot: p.reservedSlot ?? null,
      yellowLog: p.yellowLog ?? [],
      morale: p.morale ?? MORALE_BASELINE,
      age: p.age ?? 25,
      salary: p.salary ?? calculateMarketValue(p.rating ?? 5),
      contractYears: p.contractYears ?? 0,
    };
    // Guard age with > 0 (not truthiness) so a persisted age of 0 isn't re-rolled.
    const withAge = player.age != null && player.age > 0 ? player : { ...player, age: computeStartingAge(player) };
    return { ...withAge, rating: computeOverall(withAge) };
  };
  const teams: Record<string, LeagueTeam> = {};
  for (const name of state.teamOrder) {
    const t = state.teams[name];
    if (!t) continue; // skip a missing/corrupt team entry rather than crashing
    const players = t.players.map(normalizePlayer);
    const formation = t.formation ?? DEFAULT_FORMATION;
    let lineup = t.lineup;
    if (!lineup || lineup.length === 0) {
      // Migrate from old `starter` booleans, falling back to a default lineup.
      const starters = players.filter((p) => p.starter).map((p) => p.name);
      lineup = starters.length === buildLineupSlots(formation).length
        ? starters
        : buildDefaultLineup(players, formation);
    }
    teams[name] = syncStarters({
      ...t,
      morale: t.morale ?? MORALE_BASELINE,
      formation,
      lineup,
      players,
      salaryBudget: t.salaryBudget ?? 0,
    });
  }
  let salaryCap = state.salaryCap ?? 0;
  let contractsInitialized = state.contractsInitialized ?? false;
  let outTeams = teams;
  if (!contractsInitialized || salaryCap <= 0) {
    const init = initializeContracts(teams, state.teamOrder);
    outTeams = init.teams;
    salaryCap = init.salaryCap;
    contractsInitialized = true;
  }
  // Merge persisted tuning knobs into the live engine singleton so every
  // engine immediately reads the current values (any load path hits normalize).
  const mergedSettings = applySettings(state.settings);
  // Managers: keep any already-persisted manager identities, seed defaults for
  // clubs that don't have one yet (older saves, newly added teams).
  const seededManagers = buildManagers(state.teamOrder);
  const managers: Record<string, ManagerRecord> = {};
  for (const name of state.teamOrder) {
    managers[name] = state.managers?.[name] ?? seededManagers[name];
  }
  return {
    ...state,
    season: state.season ?? 1,
    tradeProposals: state.tradeProposals ?? [],
    pressArchive: state.pressArchive ?? [],
    payloads: state.payloads ?? {},
    undoStack: state.undoStack ?? [],
    redoStack: state.redoStack ?? [],
    teams: outTeams,
    salaryCap,
    freeAgents: (state.freeAgents ?? []).map(normalizePlayer),
    contractsInitialized,
    managers,
    settings: { ...mergedSettings, contractExemptTeams: [...mergedSettings.contractExemptTeams] },
    // Draft picks must always exist (48). Backfill for older saves, keeping any
    // existing ownership; if the set is missing/wrong size, rebuild from scratch.
    draftPicks:
      state.draftPicks && state.draftPicks.length === DRAFT_POOL_SIZE
        ? state.draftPicks
        : buildDraftPicks(state.teamOrder, state.season ?? 1),
    draft: state.draft
      ? {
          ...state.draft,
          prospects: (state.draft.prospects ?? []).map(normalizePlayer),
          selections: state.draft.selections ?? [],
        }
      : undefined,
  };
}

function loadState(): LeagueState {
  if (typeof window === "undefined") return initState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // Force the undo/redo history empty on load — it is session-only and must
    // match the server-rendered (empty) state to avoid a hydration mismatch.
    if (raw) return normalize({ ...(JSON.parse(raw) as LeagueState), undoStack: [], redoStack: [] });
    for (const key of LEGACY_STORAGE_KEYS) {
      const legacy = window.localStorage.getItem(key);
      if (legacy) return normalize({ ...(JSON.parse(legacy) as LeagueState), undoStack: [], redoStack: [] });
    }
  } catch {
    /* ignore corrupt state */
  }
  return initState();
}

// ---------------- Standings ----------------
export function computeStandings(state: LeagueState): StandingRow[] {
  const rows: Record<string, StandingRow> = {};
  state.teamOrder.forEach((name) => {
    rows[name] = { rank: 0, team: name, pld: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
  });
  for (const fx of state.fixtures) {
    const r = state.results[fx.id];
    if (!r) continue;
    const h = rows[fx.home];
    const a = rows[fx.away];
    if (!h || !a) continue;
    h.pld++; a.pld++;
    h.gf += r.homeGoals; h.ga += r.awayGoals;
    a.gf += r.awayGoals; a.ga += r.homeGoals;
    if (r.homeGoals > r.awayGoals) { h.w++; a.l++; h.pts += 3; }
    else if (r.homeGoals < r.awayGoals) { a.w++; h.l++; a.pts += 3; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  const list = Object.values(rows);
  list.forEach((row) => { row.gd = row.gf - row.ga; });
  list.sort((x, y) =>
    y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.team.localeCompare(y.team)
  );
  list.forEach((row, i) => { row.rank = i + 1; });
  return list;
}

// ---------------- Player leaderboards (derived from match payloads) ----------------
export function computeLeaderboards(state: LeagueState): Leaderboards {
  const scorerMap = new Map<string, ScorerRow>();
  const keeperMap = new Map<string, KeeperRow>();

  for (const payload of Object.values(state.payloads)) {
    for (const p of payload.players) {
      const key = `${p.team}::${p.name}`;
      const cur = scorerMap.get(key) ?? { team: p.team, name: p.name, goals: 0, assists: 0 };
      cur.goals += p.goals;
      cur.assists += p.assists;
      scorerMap.set(key, cur);
    }
    for (const g of payload.goalkeepers) {
      const key = `${g.team}::${g.name}`;
      const cur = keeperMap.get(key) ?? { team: g.team, name: g.name, cleanSheets: 0, conceded: 0, apps: 0 };
      cur.cleanSheets += g.cleanSheet ? 1 : 0;
      cur.conceded += g.conceded;
      cur.apps += 1;
      keeperMap.set(key, cur);
    }
  }

  const scorers = [...scorerMap.values()]
    .filter((r) => r.goals > 0)
    .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name));
  const assists = [...scorerMap.values()]
    .filter((r) => r.assists > 0)
    .map((r) => ({ team: r.team, name: r.name, assists: r.assists, goals: r.goals }))
    .sort((a, b) => b.assists - a.assists || b.goals - a.goals || a.name.localeCompare(b.name));
  const keepers = [...keeperMap.values()]
    .filter((r) => r.apps > 0)
    .sort((a, b) => b.cleanSheets - a.cleanSheets || a.conceded - b.conceded || a.name.localeCompare(b.name));

  return { scorers, assists, keepers };
}

// ---------------- Schedule helpers ----------------
export function isWeekComplete(state: LeagueState, week: number): boolean {
  const wk = state.fixtures.filter((f) => f.week === week);
  return wk.length > 0 && wk.every((f) => state.results[f.id]);
}

export function maxScheduledWeek(state: LeagueState): number {
  return state.fixtures.reduce((m, f) => Math.max(m, f.week), 0);
}

const ROUND_NAMES = ["", "Wild Card", "Divisional", "Semifinal", "Final"];
export const PLAYOFF_ROUND_NAMES = ROUND_NAMES;

// ---------------- Playoffs (NFL-style reseeding) ----------------
function buildRound(
  round: number,
  participants: { team: string; seed: number }[]
): PlayoffMatch[] {
  const sorted = [...participants].sort((a, b) => a.seed - b.seed);
  const out: PlayoffMatch[] = [];
  const n = sorted.length;
  for (let i = 0; i < n / 2; i++) {
    const high = sorted[i];
    const low = sorted[n - 1 - i];
    out.push({
      id: `po-r${round}-m${i}`,
      round,
      homeSeed: high.seed,
      awaySeed: low.seed,
      home: high.team,
      away: low.team,
    });
  }
  return out;
}

export function matchWinner(m: PlayoffMatch): string | null {
  if (!m.result) return null;
  if (m.result.homeGoals > m.result.awayGoals) return m.home;
  if (m.result.awayGoals > m.result.homeGoals) return m.away;
  return null; // tie — must be resolved before advancing
}

function buildPlayoffs(state: LeagueState): PlayoffsState {
  const seeds = computeStandings(state).slice(0, 14).map((s) => s.team);
  const wildCard = seeds.slice(2).map((team, i) => ({ team, seed: i + 3 }));
  return { seeds, rounds: [buildRound(1, wildCard)] };
}

function seedOf(playoffs: PlayoffsState, team: string): number {
  return playoffs.seeds.indexOf(team) + 1;
}

function advancePlayoffs(playoffs: PlayoffsState): PlayoffsState {
  const last = playoffs.rounds[playoffs.rounds.length - 1];
  const winners = last.map(matchWinner);
  if (winners.some((w) => w === null)) return playoffs;
  const roundNum = last[0].round;

  if (roundNum === 4) {
    return { ...playoffs, champion: winners[0]! };
  }

  let advancing: string[] = winners as string[];
  if (roundNum === 1) {
    advancing = [playoffs.seeds[0], playoffs.seeds[1], ...advancing];
  }
  if (advancing.length < 2) return playoffs;

  const participants = advancing.map((team) => ({ team, seed: seedOf(playoffs, team) }));
  const next = buildRound(roundNum + 1, participants);
  return { ...playoffs, rounds: [...playoffs.rounds, next] };
}

export function isManualOnly(home: string, away: string): boolean {
  return isManualSimTeam(home) || isManualSimTeam(away);
}

// Build the ordered roster for the engine: available starters first, then
// available bench. Injured/suspended players are excluded entirely. Morale
// scales the attributes fed into the engine.
export function rosterForEngine(team: LeagueTeam) {
  const available = team.players.filter((p) => !isPlayerOut(p));
  const inLineup = new Set(team.lineup.filter(Boolean));
  const starters = available.filter((p) => inLineup.has(p.name));
  const bench = available.filter((p) => !inLineup.has(p.name));
  return [...starters, ...bench].map((p) => {
    const a = moraleScaledAttrs(p, team.morale, p.morale);
    return {
      name: p.name, position: p.position, rating: a.rating,
      FIN: a.FIN, SHO: a.SHO, PAS: a.PAS, VIS: a.VIS, DRI: a.DRI, PAC: a.PAC, STA: a.STA,
      DEF: a.DEF, TAC: a.TAC, POS_attr: a.POS_attr, COM: a.COM, WR: a.WR, AGG: a.AGG,
      STR: a.STR, AER: a.AER,
    };
  });
}

export interface SimOutput {
  log: string[];
  homeGoals: number;
  awayGoals: number;
  injured: { team: string; name: string }[]; // severe (carried off) injuries
  payload: MatchPayload;
}

export function simulateMatch(
  state: LeagueState,
  home: string,
  away: string,
  tempo: number,
  goalMultiplier: number,
  playoff = false
): SimOutput {
  const ht = state.teams[home];
  const at = state.teams[away];
  const engineHome = buildEngineTeam(ht.name, ht.tactical_style, rosterForEngine(ht));
  const engineAway = buildEngineTeam(at.name, at.tactical_style, rosterForEngine(at));
  const result = run_match(engineHome, engineAway, tempo, goalMultiplier, playoff);

  const payload = buildMatchPayload(
    engineHome, engineAway, home, away, result.homeGoals, result.awayGoals
  );
  return { ...result, injured: payload.injuries, payload };
}

// ---------------- Match effects (injuries + disciplinary) ----------------
function applyMatchEffects(
  teams: Record<string, LeagueTeam>,
  payload: MatchPayload | undefined,
  injured: { team: string; name: string }[] | undefined,
  currentWeek: number
): { teams: Record<string, LeagueTeam>; protectedKeys: Set<string> } {
  const next = { ...teams };
  const protectedKeys = new Set<string>();
  // Players benched by this match (red, second yellow, injury) — their starting
  // slot is reserved so they reclaim it when they recover.
  const outPlayers: { team: string; name: string }[] = [];

  const updatePlayerIn = (
    teamName: string,
    playerName: string,
    fn: (p: LeaguePlayer) => LeaguePlayer
  ) => {
    const team = next[teamName];
    if (!team) return;
    const idx = team.players.findIndex((p) => p.name === playerName);
    if (idx < 0) return;
    const players = team.players.map((p, i) => (i === idx ? fn(p) : p));
    next[teamName] = { ...team, players };
  };

  if (payload) {
    for (const ps of payload.players) {
      if (ps.red) {
        updatePlayerIn(ps.team, ps.name, (p) => ({
          ...p,
          suspensionWeeks: Math.max(p.suspensionWeeks, RED_SUSPENSION),
          yellowLog: [],
          starter: false,
        }));
        protectedKeys.add(`${ps.team}::${ps.name}`);
        outPlayers.push({ team: ps.team, name: ps.name });
      } else if (ps.yellow > 0) {
        updatePlayerIn(ps.team, ps.name, (p) => {
          const log = [...p.yellowLog, currentWeek].filter(
            (w) => w > currentWeek - YELLOW_WINDOW_WEEKS
          );
          if (log.length >= 2) {
            protectedKeys.add(`${ps.team}::${ps.name}`);
            outPlayers.push({ team: ps.team, name: ps.name });
            return {
              ...p,
              suspensionWeeks: Math.max(p.suspensionWeeks, YELLOW_SUSPENSION),
              yellowLog: [],
              starter: false,
            };
          }
          return { ...p, yellowLog: log };
        });
      }
    }
  }

  if (injured && injured.length) {
    for (const inj of injured) {
      updatePlayerIn(inj.team, inj.name, (p) => ({
        ...p,
        injuryWeeks: Math.max(p.injuryWeeks, rollInjuryWeeks()),
        starter: false,
      }));
      protectedKeys.add(`${inj.team}::${inj.name}`);
      outPlayers.push({ team: inj.team, name: inj.name });
    }
  }

  // Reserve each benched player's starting slot and vacate it for a replacement.
  for (const out of outPlayers) {
    if (next[out.team]) next[out.team] = markReserved(next[out.team], out.name);
  }

  return { teams: next, protectedKeys };
}

// ---------------- Morale: match events ----------------
// Mutates clones of the two affected clubs in the teams map and returns a new
// map. Disciplinary/injury changes already applied to those players are kept.
function applyMatchMorale(
  teams: Record<string, LeagueTeam>,
  standings: StandingRow[],
  homeName: string,
  awayName: string,
  homeGoals: number,
  awayGoals: number,
  payload: MatchPayload | undefined
): Record<string, LeagueTeam> {
  const next = { ...teams };
  const clone = (name: string): LeagueTeam | undefined => {
    if (!next[name]) return undefined;
    const t: LeagueTeam = { ...next[name], players: next[name].players.map((p) => ({ ...p })) };
    next[name] = t;
    return t;
  };
  const home = clone(homeName);
  const away = clone(awayName);
  if (!home || !away) return next;

  const rankOf = (name: string) => standings.find((s) => s.team === name)?.rank ?? 99;
  const total = standings.length;
  const top5 = (name: string) => rankOf(name) <= 5;
  const bottom5 = (name: string) => rankOf(name) > total - 5;

  // Team macro events (apply to all 24 clubs).
  if (homeGoals === awayGoals) {
    applyTeamEvent(home, "stalemate");
    applyTeamEvent(away, "stalemate");
  } else {
    const winner = homeGoals > awayGoals ? home : away;
    const loser = homeGoals > awayGoals ? away : home;
    applyTeamEvent(winner, top5(loser.name) ? "elite_victory" : "standard_victory");
    applyTeamEvent(loser, bottom5(winner.name) ? "upset_defeat" : "standard_defeat");
  }

  // Player micro events (exempt clubs are skipped inside applyPlayerEvent).
  if (payload) {
    const sideOf = (teamName: string) => (teamName === home.name ? home : teamName === away.name ? away : undefined);
    for (const ps of payload.players) {
      const side = sideOf(ps.team);
      if (!side) continue;
      const player = side.players.find((p) => p.name === ps.name);
      if (!player) continue;
      for (let i = 0; i < ps.goals; i++) applyPlayerEvent(side, player, "goal");
      for (let i = 0; i < ps.assists; i++) applyPlayerEvent(side, player, "assist");
      for (let i = 0; i < ps.yellow; i++) applyPlayerEvent(side, player, "yellow_card");
      if (ps.red) applyPlayerEvent(side, player, "red_card");
      if (ps.injured) applyPlayerEvent(side, player, "injured");
    }
    for (const g of payload.goalkeepers) {
      const side = sideOf(g.team);
      if (!side || !g.cleanSheet) continue;
      const keeper = side.players.find((p) => p.name === g.name);
      if (keeper) applyPlayerEvent(side, keeper, "clean_sheet");
    }
    // Locker room crisis: a starter injured during the match.
    for (const inj of payload.injuries) {
      const side = sideOf(inj.team);
      if (side) applyTeamEvent(side, "locker_room_crisis");
    }
  }

  return next;
}

// ---------------- Context ----------------
interface LeagueContextValue {
  state: LeagueState;
  setResult: (
    fixtureId: string,
    homeGoals: number,
    awayGoals: number,
    method: "SIM" | "MANUAL",
    payload?: MatchPayload
  ) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  setSalaryCap: (cap: number) => void;
  setSettings: (patch: Partial<EngineSettings>) => void;
  revertToVersion: (data: VersionData) => void;
  importLeagueExport: (raw: unknown) => { ok: true } | { ok: false; error: string };
  updateBudget: (team: string, budget: string) => void;
  setTacticalStyle: (team: string, style: string) => void;
  updatePlayer: (team: string, index: number, patch: Partial<LeaguePlayer>) => void;
  setLineupSlot: (team: string, slot: number, playerName: string) => void;
  setFormation: (team: string, formation: string) => void;
  autoFillLineup: (team: string) => void;
  setInjuryWeeks: (team: string, index: number, weeks: number) => void;
  setSuspensionWeeks: (team: string, index: number, weeks: number) => void;
  addPlayer: (team: string) => void;
  addYouthPlayer: (team: string) => void;
  removePlayer: (team: string, index: number) => void;
  renameTeam: (oldName: string, newName: string) => void;
  addFixtures: (entries: { week: number; home: string; away: string }[]) => void;
  removeFixture: (fixtureId: string) => void;
  scheduleFinalFour: (entries: { week: number; home: string; away: string }[]) => void;
  scheduleNewSeason: (entries: { week: number; home: string; away: string }[]) => void;
  startNewSeason: () => void;
  generatePlayoffs: () => void;
  setPlayoffResult: (matchId: string, homeGoals: number, awayGoals: number, method: "SIM" | "MANUAL", payload?: MatchPayload) => void;
  executeTrade: (proposal: TradeProposal) => void;
  executeManualTrade: (teamA: string, teamB: string, aPlayers: string[], bPlayers: string[], cashAReceives: number, cashBReceives: number, aPickIds?: string[], bPickIds?: string[]) => void;
  declineTrade: (proposalId: string) => void;
  refreshTradeProposals: () => void;
  setTradeProposals: (proposals: TradeProposal[]) => void;
  replaceManager: (team: string, manager: { name: string; personality: string }) => void;
  setSalary: (team: string, index: number, salary: number) => void;
  setContractYears: (team: string, index: number, years: number) => void;
  setPlayerForSale: (team: string, index: number, on: boolean) => void;
  setPlayerAgent: (team: string, index: number, agent: { name: string; personality: string; tolerance: string }) => void;
  signNewContract: (team: string, index: number, salary: number, years: number) => void;
  signFreeAgent: (team: string, freeAgentName: string) => void;
  runContractCycle: () => ContractAction[];
  // Draft
  setDraftProspects: (prospects: LeaguePlayer[]) => void;
  startDraft: () => void;
  selectProspect: (pickId: string, prospectName: string) => void;
  advanceDraftPick: () => void;
  resetDraft: () => void;
  resetMorale: () => void;
  resetLeague: () => void;
  // Relations + manager respect/harshness mutators (Press Conferences + DMs)
  applyRelationDelta: (aiTeam: string, delta: number) => void;
  applyManagerRespectDelta: (team: string, delta: number) => void;
  // Same as applyManagerRespectDelta but uses the separate pressConferenceVolatility
  // multiplier — press-conference respect swings are tuned independently from
  // match-results / standings drift so the user can make interviews as
  // consequential as they want without changing the whole season's rhythm.
  applyPressRespectDelta: (team: string, delta: number) => void;
  applyManagerHarshnessSample: (team: string, sample: number) => void;
  applyPlayerMoraleDelta: (team: string, playerName: string, delta: number) => void;
  applyTeamMoraleDelta: (team: string, delta: number) => void;
  appendPressEntry: (entry: Omit<PressArchiveEntry, "id" | "createdAt"> & { id?: string; createdAt?: string }) => void;
  clearPressArchive: () => void;
  // Media article archive (auto-filed after every Newsroom generation).
  appendArticleEntry: (entry: Omit<ArticleArchiveEntry, "id" | "createdAt"> & { id?: string; createdAt?: string }) => void;
  clearArticleArchive: () => void;
  // Public league events (used by press / news / rivals to reference sackings).
  appendLeagueEvent: (event: Omit<LeagueEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }) => void;
  // "Fire manager and hire new" — a full public reset of everything tied to
  // a manager slot (used by the Team Editor Suite). Resets respect, harshness,
  // team & player morale, wipes DM history (client-side + Supabase, best
  // effort), clears relations from other clubs, logs a league event.
  fireAndHireManager: (team: string, incoming: { name: string; personality: string }) => void;
  // AI sacking (invoked by AiSackingWatcher after the boardroom review call).
  sackAiManager: (team: string, reason?: string) => void;
  standings: StandingRow[];
  leaderboards: Leaderboards;
}

const LeagueContext = createContext<LeagueContextValue | null>(null);

// Auto-promote acquired players into the lineup if they outrate the current
// weakest starter. Goalkeepers target the GK slot; outfielders target any
// outfield slot (any player can play any outfield position).
function autoPromote(team: LeagueTeam, incoming: LeaguePlayer[]): LeagueTeam {
  const slots = buildLineupSlots(team.formation);
  const lineup = [...team.lineup];
  for (const inc of incoming) {
    if (isPlayerOut(inc)) continue; // injured/suspended arrivals start on the bench
    if (lineup.includes(inc.name)) continue; // already starting
    const targetGroup: LineupSlot["group"] = positionGroup(inc.position) === "GK" ? "GK" : "OUT";
    let worstIdx = -1;
    let worstRating = Infinity;
    slots.forEach((s, i) => {
      if (s.group !== targetGroup) return;
      const cur = team.players.find((p) => p.name === lineup[i]);
      const r = cur ? cur.rating : -1;
      if (r < worstRating) { worstRating = r; worstIdx = i; }
    });
    if (worstIdx >= 0 && inc.rating > worstRating) lineup[worstIdx] = inc.name;
  }
  return { ...team, lineup };
}

// Repair a lineup so it never references a missing player or leaves a hole. First
// drops "ghost" names no longer on the roster (released / removed / traded-away),
// then backfills every empty starting slot with the best available healthy
// reserve so a club is never left a man short. GK slots prefer a goalkeeper;
// outfield slots take the highest-rated healthy bench player. Re-syncs starter
// flags before returning.
function repairLineup(team: LeagueTeam): LeagueTeam {
  const slots = buildLineupSlots(team.formation);
  const roster = new Set(team.players.map((p) => p.name));
  // Align length to the formation and strip references to absent players.
  const lineup = slots.map((_, i) => {
    const n = team.lineup[i] ?? "";
    return n && roster.has(n) ? n : "";
  });
  if (lineup.includes("")) {
    const used = new Set(lineup.filter(Boolean));
    const ranked = [...team.players].sort((a, b) => b.rating - a.rating);
    slots.forEach((slot, i) => {
      if (lineup[i]) return;
      let pick: LeaguePlayer | undefined;
      if (slot.group === "GK") {
        pick = ranked.find(
          (p) => !used.has(p.name) && !isPlayerOut(p) && positionGroup(p.position) === "GK"
        );
      }
      if (!pick) pick = ranked.find((p) => !used.has(p.name) && !isPlayerOut(p));
      if (pick) { used.add(pick.name); lineup[i] = pick.name; }
    });
  }
  return syncStarters({ ...team, lineup });
}

// Drain any manager sacks recorded during the just-applied morale events and
// queue AI-generated replacements (pendingGeneration). Returns the updated
// managers map (unchanged reference when nothing was sacked).
function withPendingSacks(managers: Record<string, ManagerRecord>): Record<string, ManagerRecord> {
  const sacked = drainSackedTeams();
  if (sacked.length === 0) return managers;
  const next = { ...managers };
  for (const name of sacked) {
    next[name] = {
      name: "Interim Manager",
      personality: "A caretaker manager holding the fort until a permanent appointment.",
      pendingGeneration: true,
    };
  }
  return next;
}

// Core multi-player trade: move named players + cash between two clubs, apply
// morale events, auto-promote upgrades, and re-sync lineups.
function moveTrade(
  prev: LeagueState,
  aName: string,
  bName: string,
  aPlayers: string[],
  bPlayers: string[],
  cashAReceives: number,
  cashBReceives: number,
  aPickIds: string[] = [],
  bPickIds: string[] = []
): LeagueState {
  if (aName === bName) return prev;
  const teamA = prev.teams[aName];
  const teamB = prev.teams[bName];
  if (!teamA || !teamB) return prev;

  const aSet = new Set(aPlayers.filter(Boolean));
  const bSet = new Set(bPlayers.filter(Boolean));
  const aPickSet = new Set(aPickIds.filter(Boolean));
  const bPickSet = new Set(bPickIds.filter(Boolean));
  // CONTRACT PRESERVATION (item 4): a traded player carries their existing
  // salary and contractYears verbatim onto the new club via spread — only
  // starter/reservedSlot/forSale are reset (the new club re-decides those).
  const movingFromA = teamA.players.filter((p) => aSet.has(p.name)).map((p) => ({ ...p, starter: false, reservedSlot: null, forSale: false }));
  const movingFromB = teamB.players.filter((p) => bSet.has(p.name)).map((p) => ({ ...p, starter: false, reservedSlot: null, forSale: false }));
  const noAssets =
    !movingFromA.length && !movingFromB.length && cashAReceives === 0 &&
    cashBReceives === 0 && aPickSet.size === 0 && bPickSet.size === 0;
  if (noAssets) return prev;



  const aBudgetBefore = parseBudget(teamA.budget);
  const bBudgetBefore = parseBudget(teamB.budget);

  // Affordability: a club can never spend cash it doesn't have — block any
  // deal that would drive either transfer budget below zero.
  if (aBudgetBefore + cashAReceives - cashBReceives < -0.001) return prev;
  if (bBudgetBefore + cashBReceives - cashAReceives < -0.001) return prev;

  let aTeam: LeagueTeam = {
    ...teamA,
    budget: formatBudget(aBudgetBefore + cashAReceives - cashBReceives),
    lineup: teamA.lineup.map((n) => (aSet.has(n) ? "" : n)),
    players: teamA.players.filter((p) => !aSet.has(p.name)).concat(movingFromB),
  };
  let bTeam: LeagueTeam = {
    ...teamB,
    budget: formatBudget(bBudgetBefore + cashBReceives - cashAReceives),
    lineup: teamB.lineup.map((n) => (bSet.has(n) ? "" : n)),
    players: teamB.players.filter((p) => !bSet.has(p.name)).concat(movingFromA),
  };

  // Auto-promote upgrades into the lineup, then backfill any slots left empty by
  // departing starters with the best healthy reserve (never field a man short).
  aTeam = repairLineup(autoPromote(aTeam, movingFromB));
  bTeam = repairLineup(autoPromote(bTeam, movingFromA));

  // Team morale: market triumph for both; asset depletion when sending without
  // receiving a player back.
  applyTeamEvent(aTeam, "market_triumph");
  applyTeamEvent(bTeam, "market_triumph");
  if (movingFromA.length > 0 && movingFromB.length === 0) applyTeamEvent(aTeam, "asset_depletion");
  if (movingFromB.length > 0 && movingFromA.length === 0) applyTeamEvent(bTeam, "asset_depletion");

  // Player career promotion / demotion based on destination club budget.
  for (const moved of movingFromA) {
    const player = bTeam.players.find((p) => p.name === moved.name);
    if (!player) continue;
    if (bBudgetBefore > aBudgetBefore) applyPlayerEvent(bTeam, player, "career_promotion");
    else if (bBudgetBefore < aBudgetBefore) applyPlayerEvent(bTeam, player, "career_demotion");
  }
  for (const moved of movingFromB) {
    const player = aTeam.players.find((p) => p.name === moved.name);
    if (!player) continue;
    if (aBudgetBefore > bBudgetBefore) applyPlayerEvent(aTeam, player, "career_promotion");
    else if (aBudgetBefore < bBudgetBefore) applyPlayerEvent(aTeam, player, "career_demotion");
  }

  aTeam = syncStarters(aTeam);
  bTeam = syncStarters(bTeam);

  // The Cap Lock: salaries travel with players (contract preservation). Block a
  // trade only if it would push a club OVER the Hard Salary Cap. Clubs already
  // above the cap may still trade as long as the deal does not increase their
  // payroll (so they can rebalance / shed salary without being frozen out).
  const cap = prev.salaryCap ?? Infinity;
  const aOver = payrollOf(aTeam) > cap + 0.001 && payrollOf(aTeam) > payrollOf(teamA) + 0.001;
  const bOver = payrollOf(bTeam) > cap + 0.001 && payrollOf(bTeam) > payrollOf(teamB) + 0.001;
  if (aOver || bOver) {
    drainSackedTeams(); // discard any events recorded for this rejected deal
    return prev;
  }

  // Reassign traded draft picks: A's picks go to B, B's picks go to A. Only
  // picks the sending club currently owns can move.
  const draftPicks = prev.draftPicks.map((pk) => {
    if (aPickSet.has(pk.id) && pk.owner === aName) return { ...pk, owner: bName };
    if (bPickSet.has(pk.id) && pk.owner === bName) return { ...pk, owner: aName };
    return pk;
  });

  return {
    ...prev,
    teams: { ...prev.teams, [aName]: aTeam, [bName]: bTeam },
    managers: withPendingSacks(prev.managers),
    draftPicks,
  };
}

// Offseason aging for one club (no automatic retirement — removals are manual).
function offseasonTeam(team: LeagueTeam): LeagueTeam {
  const players: LeaguePlayer[] = [];
  let moraleBump = 0;
  for (const p of team.players) {
    const res = ageOnePlayer({ ...p, injuryWeeks: 0, suspensionWeeks: 0, reservedSlot: null, yellowLog: [] });
    if (res.veteranFulfilled) moraleBump += 1;
    players.push(res.player);
  }
  // Veteran fulfillment lifts overall club morale slightly.
  // Morale carries into the next season, then regresses 7 points toward the
  // 50 baseline; veteran fulfilment adds a small bump on top.
  const morale = Math.max(0, Math.min(100, carryOverMorale(team.morale) + moraleBump * 2));
  const lineup = buildDefaultLineup(players, team.formation);
  return syncStarters({ ...team, players, morale, lineup });
}

const CLOUD_ROW_ID = "main";

// Weekly respect drift. Respect drifts toward 50 + standings tilt, with an
// extra penalty for very harsh / very cheery managers (extremes erode respect).
// User-controlled clubs are skipped. All deltas scaled by managerRatingVolatility.
function applyRespectTick(state: LeagueState): LeagueState {
  const rows = computeStandings(state);
  const rankOf = (team: string) => rows.find((r) => r.team === team)?.rank ?? Math.ceil(state.teamOrder.length / 2);
  const total = state.teamOrder.length;
  const mult = state.settings?.managerRatingVolatility ?? 1;
  const sackAt = state.settings?.sackThreshold ?? 25;
  const managers: Record<string, ManagerRecord> = {};
  const teams = { ...state.teams };
  let changed = false;
  for (const name of state.teamOrder) {
    const m = state.managers?.[name];
    if (!m) continue;
    if ((m.personality ?? "").trim().toUpperCase() === "USER CONTROLLED") {
      managers[name] = m; continue;
    }
    const cur = typeof m.respect === "number" ? m.respect : 50;
    const midpoint = (total + 1) / 2;
    // Standings weight: the base tilt magnitude used to be 22 (a top-of-table
    // manager pulled toward ~72). Multiply by standingsWeight so match
    // results/standings clearly dominate weekly respect drift — leading the
    // table gets you noticeably more respect than a middle-of-the-pack finish.
    const standingsWeight = state.settings?.standingsWeight ?? 1;
    const tilt = (midpoint - rankOf(name)) * ((22 * standingsWeight) / midpoint);
    const target = 50 + tilt;
    // Bumped pull rate from 0.15 → 0.22 so standings matter more per week too.
    let next = cur + (target - cur) * 0.22;
    const harsh = typeof m.harshness === "number" ? m.harshness : 0.5;
    const dev = Math.abs(harsh - 0.5);
    if (dev > 0.25) next -= (dev - 0.25) * 6;
    next = Math.max(0, Math.min(100, cur + (next - cur) * mult));
    // Sacking is NOT auto-triggered here anymore — AiSackingWatcher runs a
    // multi-factor boardroom review each week and calls sackAiManager().
    if (Math.abs(next - cur) > 0.05) changed = true;
    managers[name] = { ...m, respect: Math.round(next * 10) / 10 };
  }
  return changed ? { ...state, managers, teams } : state;
}


export function LeagueProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LeagueState>(() => loadState());

  // Cloud sync bookkeeping.
  const versionRef = useRef<number>(0); // last version we know about from Cloud
  const selfVersionRef = useRef<number>(-1); // version of our own most recent write (ignore its echo)
  const hydratedRef = useRef(false); // becomes true after the first Cloud reconcile
  const applyingRemoteRef = useRef(false); // skip persisting a state that just arrived from Cloud
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<LeagueState | null>(null);

  // Persist the live league document to Cloud (undo history is kept local only).
  function pushToCloud(snapshot: LeagueState) {
    const prevVersion = versionRef.current;
    const nextVersion = prevVersion + 1;
    const { undoStack: _ignore, redoStack: _ignore2, ...rest } = snapshot;
    const data = { ...rest, undoStack: [], redoStack: [] };
    versionRef.current = nextVersion;
    selfVersionRef.current = nextVersion;
    void supabase
      .from("league_state")
      .upsert({ id: CLOUD_ROW_ID, data: data as unknown as Record<string, unknown>, version: nextVersion, updated_at: new Date().toISOString() } as never)
      .then(({ error }) => {
        if (error) {
          console.warn("[league] cloud save failed", error.message);
          // Roll back the optimistic version bump so a FAILED write doesn't leave
          // versionRef ahead of Cloud — otherwise later remote updates look "stale"
          // and get silently ignored. Only roll back if no newer write intervened.
          if (versionRef.current === nextVersion) versionRef.current = prevVersion;
        }
      });
  }

  // Initial hydration: load the shared league from Cloud, or seed it from local state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("league_state")
        .select("data, version")
        .eq("id", CLOUD_ROW_ID)
        .maybeSingle();
      if (cancelled) return;
      if (!error && data) {
        versionRef.current = data.version ?? 1;
        applyingRemoteRef.current = true;
        try {
          setState((prev) => normalize({ ...(data.data as unknown as LeagueState), undoStack: prev.undoStack, redoStack: prev.redoStack }));
        } catch {
          applyingRemoteRef.current = false; // corrupt Cloud row — keep local state rather than crash
        }
      } else {
        // No shared league yet — seed it from whatever this browser currently has.
        setState((prev) => {
          pushToCloud(prev);
          return prev;
        });
      }
      hydratedRef.current = true;
    })();

    // Live multi-window sync.
    const channel = supabase
      .channel("league_state_sync")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "league_state", filter: `id=eq.${CLOUD_ROW_ID}` },
        (payload) => {
          const row = payload.new as { data?: LeagueState; version?: number } | null;
          if (!row || row.version == null || row.data == null) return;
          if (row.version === selfVersionRef.current) return; // our own write echoing back
          if (row.version <= versionRef.current) return; // stale
          versionRef.current = row.version;
          applyingRemoteRef.current = true;
          try {
            setState((prev) => normalize({ ...(row.data as LeagueState), undoStack: prev.undoStack, redoStack: prev.redoStack }));
          } catch {
            applyingRemoteRef.current = false; // ignore a corrupt remote payload rather than crash
          }
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist every change: local cache (instant fallback) + debounced Cloud write.
  useEffect(() => {
    try {
      // Undo/redo history is session-only (in memory). Persisting it to
      // localStorage makes the client hydrate with a different canUndo/canRedo
      // than the server rendered, which React refuses to patch up — leaving the
      // toolbar buttons stuck with a stale `disabled` attribute.
      const { undoStack: _u, redoStack: _r, ...persistable } = state;
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...persistable, undoStack: [], redoStack: [] }),
      );
    } catch {
      /* storage full / unavailable */
    }
    if (!hydratedRef.current) return; // don't write back during initial hydration
    if (applyingRemoteRef.current) {
      applyingRemoteRef.current = false; // this state came from Cloud; don't echo it
      return;
    }
    pendingRef.current = state;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (pendingRef.current) pushToCloud(pendingRef.current);
    }, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // ---------------- League history archive (item 3) ----------------
  // When a playoffs champion is freshly crowned, quietly write a season summary
  // to the cloud history table. Runs only when the (season, champion) tuple
  // changes — no UI, no extra writes during routine state churn.
  const archivedRef = useRef<string | null>(null);
  useEffect(() => {
    const champion = state.playoffs?.champion;
    if (!champion) return;
    const key = `${state.season}::${champion}`;
    if (archivedRef.current === key) return;
    archivedRef.current = key;
    void import("@/lib/league-history").then((m) => m.recordCompletedSeason(state));
  }, [state.season, state.playoffs?.champion]); // eslint-disable-line react-hooks/exhaustive-deps

  const standings = useMemo(() => computeStandings(state), [state]);
  const leaderboards = useMemo(() => computeLeaderboards(state), [state]);

  // Universal undo: every mutating action snapshots the prior state and clears
  // the redo stack (a fresh action invalidates any undone future).
  function update(producer: (prev: LeagueState) => LeagueState) {
    setState((prev) => {
      const next = producer(prev);
      if (next === prev) return prev;
      const snap = JSON.stringify({ ...prev, undoStack: [], redoStack: [] });
      return { ...next, undoStack: [...prev.undoStack, snap].slice(-MAX_UNDO), redoStack: [] };
    });
  }

  function onWeekAdvanced(next: LeagueState, protectedKeys: Set<string>): LeagueState {
    const teams: Record<string, LeagueTeam> = {};
    for (const name of next.teamOrder) {
      const t = next.teams[name];
      const inLineup = new Set(t.lineup.filter(Boolean));
      const exempt = isManualSimTeam(name);
      const returning: string[] = [];
      const players = t.players.map((p) => {
        let np = p;
        let returnedThisWeek = false;
        if (!protectedKeys.has(`${name}::${p.name}`) && (p.injuryWeeks > 0 || p.suspensionWeeks > 0)) {
          const wasOut = p.injuryWeeks > 0 || p.suspensionWeeks > 0;
          np = {
            ...p,
            injuryWeeks: p.injuryWeeks >= SEASON_ENDING_WEEKS ? p.injuryWeeks : Math.max(0, p.injuryWeeks - 1),
            suspensionWeeks: Math.max(0, p.suspensionWeeks - 1),
          };
          // Comeback: returned to availability this week.
          if (wasOut && np.injuryWeeks === 0 && np.suspensionWeeks === 0) {
            np = { ...np, morale: clampMorale(np.morale + 15) };
            returning.push(np.name);
            returnedThisWeek = true;
          }
        }
        // Weekly selection / bench morale (player micro-events skip exempt clubs).
        // Skip on the comeback week so a returning player isn't double-counted
        // (the +15 comeback bonus already covers that week).
        if (!exempt && !returnedThisWeek && np.injuryWeeks === 0 && np.suspensionWeeks === 0) {
          const delta = inLineup.has(np.name) ? 5 : -10;
          np = { ...np, morale: clampMorale(np.morale + delta) };
        }
        return np;
      });
      let team = { ...t, players };
      // Restore recovered players to the exact slot they held before going out.
      for (const recoveredName of returning) {
        team = restoreReserved(team, recoveredName);
      }
      teams[name] = team;
    }
    let advanced: LeagueState = { ...next, teams };
    if (advanced.currentWeek <= engineSettings.transferWindowLastWeek) {
      advanced = { ...advanced, tradeProposals: generateTradeProposals(advanced) };
    }
    // Weekly manager respect drift: standings + harshness-extreme penalty,
    // scaled by managerRatingVolatility. Skips user-controlled clubs.
    advanced = applyRespectTick(advanced);
    return advanced;
  }

  function advanceWeekIfComplete(next: LeagueState, protectedKeys: Set<string>): LeagueState {
    const wk = next.currentWeek;
    const weekFixtures = next.fixtures.filter((f) => f.week === wk);
    const allPlayed = weekFixtures.length > 0 && weekFixtures.every((f) => next.results[f.id]);
    if (!allPlayed) return next;
    const maxWeek = maxScheduledWeek(next);
    if (wk < maxWeek) {
      return onWeekAdvanced({ ...next, currentWeek: wk + 1 }, protectedKeys);
    }
    return onWeekAdvanced(next, protectedKeys);
  }

  const value: LeagueContextValue = {
    state,
    standings,
    leaderboards,
    canUndo: state.undoStack.length > 0,
    canRedo: state.redoStack.length > 0,
    setResult: (fixtureId, homeGoals, awayGoals, method, payload) =>
      update((prev) => {
        if (prev.results[fixtureId]) return prev; // already recorded — never double-apply effects
        const fixture = prev.fixtures.find((f) => f.id === fixtureId);
        const preStandings = computeStandings(prev);
        const { teams, protectedKeys } = applyMatchEffects(
          prev.teams, payload, payload?.injuries, prev.currentWeek
        );
        const moraleTeams = fixture
          ? applyMatchMorale(teams, preStandings, fixture.home, fixture.away, homeGoals, awayGoals, payload)
          : teams;
        const next: LeagueState = {
          ...prev,
          teams: moraleTeams,
          managers: withPendingSacks(prev.managers),
          results: { ...prev.results, [fixtureId]: { homeGoals, awayGoals, method } },
          payloads: payload ? { ...prev.payloads, [fixtureId]: payload } : prev.payloads,
        };
        return advanceWeekIfComplete(next, protectedKeys);
      }),
    undo: () =>
      setState((prev) => {
        if (!prev.undoStack.length) return prev;
        const stack = [...prev.undoStack];
        const last = stack.pop()!;
        try {
          const restored = JSON.parse(last) as LeagueState;
          const redoSnap = JSON.stringify({ ...prev, undoStack: [], redoStack: [] });
          return normalize({
            ...restored,
            undoStack: stack,
            redoStack: [...prev.redoStack, redoSnap].slice(-MAX_UNDO),
          });
        } catch {
          return prev;
        }
      }),
    redo: () =>
      setState((prev) => {
        if (!prev.redoStack.length) return prev;
        const stack = [...prev.redoStack];
        const last = stack.pop()!;
        try {
          const restored = JSON.parse(last) as LeagueState;
          const undoSnap = JSON.stringify({ ...prev, undoStack: [], redoStack: [] });
          return normalize({
            ...restored,
            redoStack: stack,
            undoStack: [...prev.undoStack, undoSnap].slice(-MAX_UNDO),
          });
        } catch {
          return prev;
        }
      }),
    updateBudget: (team, budget) =>
      update((prev) => ({
        ...prev,
        teams: { ...prev.teams, [team]: { ...prev.teams[team], budget } },
      })),
    setTacticalStyle: (team, style) =>
      update((prev) => ({
        ...prev,
        teams: { ...prev.teams, [team]: { ...prev.teams[team], tactical_style: style } },
      })),
    updatePlayer: (team, index, patch) =>
      update((prev) => {
        const oldName = prev.teams[team].players[index]?.name;
        const players = prev.teams[team].players.map((p, i) => {
          if (i !== index) return p;
          const merged = { ...p, ...patch };
          return { ...merged, rating: computeOverall(merged) };
        });
        // If the player was renamed, keep the lineup reference in sync.
        const newName = players[index]?.name;
        let lineup = prev.teams[team].lineup;
        if (oldName && newName && oldName !== newName) {
          lineup = lineup.map((n) => (n === oldName ? newName : n));
        }
        return {
          ...prev,
          teams: { ...prev.teams, [team]: syncStarters({ ...prev.teams[team], players, lineup }) },
        };
      }),
    setLineupSlot: (team, slot, playerName) =>
      update((prev) => {
        const t = prev.teams[team];
        const lineup = [...t.lineup];
        // Prevent duplicates: clear the player from any other slot first.
        for (let i = 0; i < lineup.length; i++) {
          if (lineup[i] === playerName && i !== slot) lineup[i] = "";
        }
        lineup[slot] = playerName;
        return { ...prev, teams: { ...prev.teams, [team]: syncStarters({ ...t, lineup }) } };
      }),
    setFormation: (team, formation) =>
      update((prev) => {
        const t = prev.teams[team];
        // Position-aware remap: keep the same starters on the pitch when
        // possible, but slot each one into the role in the NEW formation that
        // best matches their listed position (LB → LB, CB → CB, ST → ST,
        // etc.). Prevents auto-fill from scrambling the XI on a formation tweak.
        const lineup = remapLineupForFormation(t.players, t.lineup, formation);
        return { ...prev, teams: { ...prev.teams, [team]: syncStarters({ ...t, formation, lineup }) } };
      }),
    autoFillLineup: (team) =>
      update((prev) => {
        const t = prev.teams[team];
        const lineup = buildDefaultLineup(t.players, t.formation);
        return { ...prev, teams: { ...prev.teams, [team]: syncStarters({ ...t, lineup }) } };
      }),
    setInjuryWeeks: (team, index, weeks) =>
      update((prev) => {
        const t = prev.teams[team];
        const target = t.players[index];
        if (!target) return prev;
        const wasOut = target.injuryWeeks > 0 || target.suspensionWeeks > 0;
        const willBeOut = Math.max(0, weeks) > 0 || target.suspensionWeeks > 0;
        let team2: LeagueTeam = {
          ...t,
          players: t.players.map((p, i) =>
            i === index ? { ...p, injuryWeeks: Math.max(0, weeks) } : p
          ),
        };
        if (!wasOut && willBeOut) team2 = markReserved(team2, target.name);
        else if (wasOut && !willBeOut) team2 = restoreReserved(team2, target.name);
        return { ...prev, teams: { ...prev.teams, [team]: team2 } };
      }),
    setSuspensionWeeks: (team, index, weeks) =>
      update((prev) => {
        const t = prev.teams[team];
        const target = t.players[index];
        if (!target) return prev;
        const wasOut = target.injuryWeeks > 0 || target.suspensionWeeks > 0;
        const willBeOut = Math.max(0, weeks) > 0 || target.injuryWeeks > 0;
        let team2: LeagueTeam = {
          ...t,
          players: t.players.map((p, i) =>
            i === index ? { ...p, suspensionWeeks: Math.max(0, weeks) } : p
          ),
        };
        if (!wasOut && willBeOut) team2 = markReserved(team2, target.name);
        else if (wasOut && !willBeOut) team2 = restoreReserved(team2, target.name);
        return { ...prev, teams: { ...prev.teams, [team]: team2 } };
      }),
    addPlayer: (team) =>
      update((prev) => ({
        ...prev,
        teams: {
          ...prev.teams,
          [team]: { ...prev.teams[team], players: [...prev.teams[team].players, blankPlayer()] },
        },
      })),
    addYouthPlayer: (team) =>
      update((prev) => ({
        ...prev,
        teams: {
          ...prev.teams,
          [team]: { ...prev.teams[team], players: [...prev.teams[team].players, youthPlayer()] },
        },
      })),
    removePlayer: (team, index) =>
      update((prev) => {
        const t = prev.teams[team];
        const players = t.players.filter((_, i) => i !== index);
        // repairLineup drops the removed player and backfills their slot from the bench.
        return { ...prev, teams: { ...prev.teams, [team]: repairLineup({ ...t, players }) } };
      }),
    renameTeam: (oldName, newName) =>
      update((prev) => {
        const trimmed = newName.trim();
        if (!trimmed || trimmed === oldName || prev.teams[trimmed]) return prev;
        const teamOrder = prev.teamOrder.map((n) => (n === oldName ? trimmed : n));
        const teams: Record<string, LeagueTeam> = {};
        for (const n of prev.teamOrder) {
          if (n === oldName) teams[trimmed] = { ...prev.teams[oldName], name: trimmed };
          else teams[n] = prev.teams[n];
        }
        const fixtures = prev.fixtures.map((f) => ({
          ...f,
          home: f.home === oldName ? trimmed : f.home,
          away: f.away === oldName ? trimmed : f.away,
        }));
        let playoffs = prev.playoffs;
        if (playoffs) {
          playoffs = {
            ...playoffs,
            seeds: playoffs.seeds.map((s) => (s === oldName ? trimmed : s)),
            champion: playoffs.champion === oldName ? trimmed : playoffs.champion,
            rounds: playoffs.rounds.map((round) =>
              round.map((m) => ({
                ...m,
                home: m.home === oldName ? trimmed : m.home,
                away: m.away === oldName ? trimmed : m.away,
              }))
            ),
          };
        }
        const tradeProposals = prev.tradeProposals.map((t) => ({
          ...t,
          teamA: t.teamA === oldName ? trimmed : t.teamA,
          teamB: t.teamB === oldName ? trimmed : t.teamB,
        }));
        const draftPicks = prev.draftPicks.map((pk) => ({
          ...pk,
          originalTeam: pk.originalTeam === oldName ? trimmed : pk.originalTeam,
          owner: pk.owner === oldName ? trimmed : pk.owner,
        }));
        return { ...prev, teamOrder, teams, fixtures, playoffs, tradeProposals, draftPicks };
      }),
    addFixtures: (entries) =>
      update((prev) => {
        const base = prev.fixtures.length;
        const added: FixtureEntry[] = entries.map((e, i) => ({
          id: `s${prev.season}-w${e.week}-m${base + i}-${Date.now() + i}`,
          week: e.week,
          home: e.home,
          away: e.away,
        }));
        return advanceWeekIfComplete({ ...prev, fixtures: [...prev.fixtures, ...added] }, new Set());
      }),
    removeFixture: (fixtureId) =>
      update((prev) => {
        const fixtures = prev.fixtures.filter((f) => f.id !== fixtureId);
        const results = { ...prev.results };
        delete results[fixtureId];
        const payloads = { ...prev.payloads };
        delete payloads[fixtureId];
        return { ...prev, fixtures, results, payloads };
      }),
    scheduleFinalFour: (entries) =>
      update((prev) => {
        const base = prev.fixtures.length;
        const added: FixtureEntry[] = entries.map((e, i) => ({
          id: `s${prev.season}-w${e.week}-m${base + i}-${Date.now() + i}`,
          week: e.week,
          home: e.home,
          away: e.away,
        }));
        return advanceWeekIfComplete({ ...prev, fixtures: [...prev.fixtures, ...added] }, new Set());
      }),
    scheduleNewSeason: (entries) =>
      update((prev) => {
        // Offseason: age all squads (no auto-retirement), carry rosters/budgets/morale.
        const season = prev.season + 1;
        const teams: Record<string, LeagueTeam> = {};
        for (const name of prev.teamOrder) {
          teams[name] = offseasonTeam(prev.teams[name]);
        }
        const fixtures: FixtureEntry[] = entries.map((e, i) => ({
          id: `s${season}-w${e.week}-m${i}-${Date.now() + i}`,
          week: e.week,
          home: e.home,
          away: e.away,
        }));
        return {
          ...prev,
          season,
          currentWeek: 1,
          fixtures,
          results: {},
          payloads: {},
          playoffs: undefined,
          tradeProposals: [],
          teams,
          draftPicks: buildDraftPicks(prev.teamOrder, season),
          draft: undefined,
        };
      }),
    startNewSeason: () =>
      update((prev) => {
        const teams: Record<string, LeagueTeam> = {};
        for (const name of prev.teamOrder) {
          teams[name] = offseasonTeam(prev.teams[name]);
        }
        return {
          ...prev,
          season: prev.season + 1,
          currentWeek: 1,
          fixtures: [],
          results: {},
          payloads: {},
          playoffs: undefined,
          tradeProposals: [],
          teams,
          draftPicks: buildDraftPicks(prev.teamOrder, prev.season + 1),
          draft: undefined,
        };
      }),
    generatePlayoffs: () =>
      update((prev) => {
        if (prev.playoffs) return prev;
        return { ...prev, playoffs: buildPlayoffs(prev) };
      }),
    setPlayoffResult: (matchId, homeGoals, awayGoals, method, payload) =>
      update((prev) => {
        if (!prev.playoffs) return prev;
        const matchObj = prev.playoffs.rounds.flat().find((m) => m.id === matchId);
        if (!matchObj || matchObj.result) return prev; // unknown or already recorded (idempotent)
        const preStandings = computeStandings(prev);
        const { teams } = applyMatchEffects(
          prev.teams, payload, payload?.injuries, prev.currentWeek
        );
        // Apply match morale just like the regular season so playoff form counts
        // (guarded so a bye/placeholder match without two real clubs is skipped).
        const moraleTeams = prev.teams[matchObj.home] && prev.teams[matchObj.away]
          ? applyMatchMorale(teams, preStandings, matchObj.home, matchObj.away, homeGoals, awayGoals, payload)
          : teams;
        const rounds = prev.playoffs.rounds.map((round) =>
          round.map((m) =>
            m.id === matchId ? { ...m, result: { homeGoals, awayGoals, method } } : m
          )
        );
        return {
          ...prev,
          teams: moraleTeams,
          managers: withPendingSacks(prev.managers),
          payloads: payload ? { ...prev.payloads, [matchId]: payload } : prev.payloads,
          playoffs: advancePlayoffs({ ...prev.playoffs, rounds }),
        };
      }),
    executeTrade: (proposal) =>
      update((prev) => {
        const next = moveTrade(
          prev, proposal.teamA, proposal.teamB,
          [proposal.aSends], [proposal.bSends],
          proposal.cashAReceives, proposal.cashBReceives,
          proposal.aPickIds ?? [], proposal.bPickIds ?? []
        );
        if (next === prev) return prev;
        return { ...next, tradeProposals: next.tradeProposals.filter((t) => t.id !== proposal.id) };
      }),
    executeManualTrade: (teamA, teamB, aPlayers, bPlayers, cashAReceives, cashBReceives, aPickIds = [], bPickIds = []) =>
      update((prev) => moveTrade(prev, teamA, teamB, aPlayers, bPlayers, cashAReceives, cashBReceives, aPickIds, bPickIds)),
    declineTrade: (proposalId) =>
      update((prev) => ({
        ...prev,
        tradeProposals: prev.tradeProposals.filter((t) => t.id !== proposalId),
      })),
    refreshTradeProposals: () =>
      update((prev) => ({ ...prev, tradeProposals: generateTradeProposals(prev) })),
    setTradeProposals: (proposals) =>
      update((prev) => ({ ...prev, tradeProposals: proposals })),
    replaceManager: (team, manager) =>
      update((prev) => {
        if (!prev.teams[team]) return prev;
        return {
          ...prev,
          managers: {
            ...prev.managers,
            [team]: { name: manager.name, personality: manager.personality },
          },
        };
      }),
    setSalary: (team, index, salary) =>
      update((prev) => {
        const players = prev.teams[team].players.map((p, i) =>
          i === index ? { ...p, salary: Math.max(0, Math.round(salary * 100) / 100) } : p
        );
        return { ...prev, teams: { ...prev.teams, [team]: { ...prev.teams[team], players } } };
      }),
    setContractYears: (team, index, years) =>
      update((prev) => {
        const players = prev.teams[team].players.map((p, i) =>
          i === index ? { ...p, contractYears: Math.max(0, Math.floor(years)) } : p
        );
        return { ...prev, teams: { ...prev.teams, [team]: { ...prev.teams[team], players } } };
      }),
    setPlayerForSale: (team, index, on) =>
      update((prev) => {
        const t = prev.teams[team];
        if (!t || !t.players[index]) return prev;
        const players = t.players.map((p, i) => (i === index ? { ...p, forSale: !!on } : p));
        return { ...prev, teams: { ...prev.teams, [team]: { ...t, players } } };
      }),
    // Persist a freshly-generated (or imported) agent identity on a player so
    // the same agent re-appears next time the user opens contract talks.
    setPlayerAgent: (team, index, agent) =>
      update((prev) => {
        const t = prev.teams[team];
        if (!t || !t.players[index]) return prev;
        const players = t.players.map((p, i) => (i === index ? { ...p, agent } : p));
        return { ...prev, teams: { ...prev.teams, [team]: { ...t, players } } };
      }),
    // Finalise an agent-negotiated contract: writes the agreed salary + years
    // back onto the player atomically.
    signNewContract: (team, index, salary, years) =>
      update((prev) => {
        const t = prev.teams[team];
        if (!t || !t.players[index]) return prev;
        const players = t.players.map((p, i) =>
          i === index
            ? {
                ...p,
                salary: Math.max(0, Math.round(salary * 100) / 100),
                contractYears: Math.max(0, Math.floor(years)),
              }
            : p
        );
        return { ...prev, teams: { ...prev.teams, [team]: { ...t, players } } };
      }),
    signFreeAgent: (team, freeAgentName) =>
      update((prev) => {
        const fa = (prev.freeAgents ?? []).find((p) => p.name === freeAgentName);
        if (!fa) return prev;
        const t = prev.teams[team];
        if (t.players.some((p) => p.name === freeAgentName)) return prev; // already on this roster — no duplicate
        const signing: LeaguePlayer = {
          ...fa, starter: false,
          salary: calculateMarketValue(fa.rating), contractYears: 1,
        };
        const post = [...t.players, signing];
        const cap = prev.salaryCap ?? Infinity;
        if (post.reduce((s, p) => s + (p.salary ?? 0), 0) > cap + 0.001) return prev; // cap lock
        return {
          ...prev,
          freeAgents: (prev.freeAgents ?? []).filter((p) => p.name !== freeAgentName),
          teams: { ...prev.teams, [team]: syncStarters({ ...t, players: post }) },
        };
      }),
    runContractCycle: () => {
      // Run the cycle inside the functional updater against the freshest state
      // (avoids the stale render-closure `state`), capturing the report to return.
      let actions: ContractAction[] = [];
      update((prev) => {
        const r = runCycle(prev);
        actions = r.actions;
        // Released players must not linger as ghost names in any lineup — repair
        // every squad so freed starters are dropped and their slots refilled.
        const teams: Record<string, LeagueTeam> = {};
        for (const name of prev.teamOrder) {
          teams[name] = r.teams[name] ? repairLineup(r.teams[name]) : r.teams[name];
        }
        return {
          ...prev,
          teams,
          freeAgents: r.freeAgents,
          salaryCap: r.salaryCap,
        };
      });
      return actions;
    },
    setSalaryCap: (cap) =>
      update((prev) => {
        const next = Math.max(0, Math.round(cap * 10) / 10);
        const teams: Record<string, LeagueTeam> = {};
        for (const name of prev.teamOrder) {
          teams[name] = { ...prev.teams[name], salaryBudget: next };
        }
        return { ...prev, salaryCap: next, teams };
      }),
    setSettings: (patch) =>
      update((prev) => {
        const current = prev.settings ?? getSettings();
        const merged: EngineSettings = {
          ...DEFAULT_SETTINGS,
          ...current,
          ...patch,
          contractExemptTeams: [
            ...(patch.contractExemptTeams ?? current.contractExemptTeams ?? DEFAULT_SETTINGS.contractExemptTeams),
          ],
        };
        applySettings(merged); // sync the live engine singleton immediately
        return { ...prev, settings: merged };
      }),
    revertToVersion: (data) =>
      // "Save everything" — a version snapshot is now the ENTIRE persistable
      // LeagueState. Restore it wholesale, preserving only the live undo/redo
      // stacks and the salaryCap app-setting (which is not league data).
      update((prev) => normalize({
        ...prev,
        ...(data as Partial<LeagueState>),
        salaryCap: prev.salaryCap,
        undoStack: prev.undoStack,
        redoStack: prev.redoStack,
      })),
    importLeagueExport: (raw) => {
      if (!raw || typeof raw !== "object") return { ok: false, error: "Not a JSON object." };
      const j = raw as Record<string, unknown>;
      if (j.kind !== "eden-league-full-export") {
        return { ok: false, error: "File is not an Eden League full export." };
      }
      // New-style export: full state under `state`. Fall back to legacy
      // top-level fields for older exports (pre "save everything" refactor).
      const s = (j.state && typeof j.state === "object")
        ? (j.state as Record<string, unknown>)
        : j;
      if (!Array.isArray(s.teamOrder) || !s.teams || typeof s.teams !== "object") {
        return { ok: false, error: "Export is missing teams/teamOrder." };
      }
      try {
        update((prev) => {
          // "Save everything" — spread the entire snapshot over prev so new
          // state slices are automatically restored without touching this
          // file. Preserve live-only stacks and the salaryCap app setting.
          // Legacy compat: match commentary was once exported as
          // `matchCommentary`; map it back to `payloads`.
          const legacyPayloads = (s.matchCommentary && !s.payloads)
            ? { payloads: s.matchCommentary as LeagueState["payloads"] }
            : {};
          return normalize({
            ...prev,
            ...(s as Partial<LeagueState>),
            ...legacyPayloads,
            salaryCap: prev.salaryCap,
            undoStack: prev.undoStack,
            redoStack: prev.redoStack,
          });
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Import failed." };
      }
    },
    setDraftProspects: (prospects) =>
      update((prev) => {
        const base: DraftState = prev.draft ?? {
          season: prev.season,
          prospects: [],
          started: false,
          order: [],
          currentPickIndex: 0,
          selections: [],
          complete: false,
        };
        return { ...prev, draft: { ...base, prospects } };
      }),
    startDraft: () =>
      update((prev) => {
        if (!prev.draft || prev.draft.prospects.length < DRAFT_POOL_SIZE) return prev;
        if (prev.draft.started) return prev;
        // Draft order = reverse final standings (last place picks first), same
        // order for both rounds.
        const standings = computeStandings(prev);
        const rankOf = (team: string) => standings.find((s) => s.team === team)?.rank ?? 99;
        const order = [...prev.draftPicks]
          .sort((a, b) => {
            if (a.round !== b.round) return a.round - b.round;
            return rankOf(b.originalTeam) - rankOf(a.originalTeam); // worst (higher rank #) first
          })
          .map((pk) => pk.id);
        return {
          ...prev,
          draft: { ...prev.draft, started: true, order, currentPickIndex: 0, complete: false },
        };
      }),
    selectProspect: (pickId, prospectName) =>
      update((prev) => {
        const draft = prev.draft;
        if (!draft || !draft.started || draft.complete) return prev;
        const pick = prev.draftPicks.find((pk) => pk.id === pickId);
        if (!pick) return prev;
        const owner = pick.owner;
        const team = prev.teams[owner];
        const prospect = draft.prospects.find((p) => p.name === prospectName);
        if (!team || !prospect) return prev;

        // Rookie contract is fixed: $2M / 2 years regardless of skill or pick.
        const rookie: LeaguePlayer = {
          ...prospect,
          starter: false,
          reservedSlot: null,
          injuryWeeks: 0,
          suspensionWeeks: 0,
          yellowLog: [],
          morale: MORALE_BASELINE,
          salary: 2.0,
          contractYears: 2,
        };
        let updatedTeam: LeagueTeam = { ...team, players: [...team.players, rookie] };
        // Auto-slot into the XI if good enough, exactly like an acquired player.
        updatedTeam = repairLineup(autoPromote(updatedTeam, [rookie]));

        const prospects = draft.prospects.filter((p) => p.name !== prospectName);
        const selections = [...draft.selections, { pickId, prospectName, team: owner }];
        const nextIndex = draft.currentPickIndex + 1;
        const complete = nextIndex >= draft.order.length;
        return {
          ...prev,
          teams: { ...prev.teams, [owner]: updatedTeam },
          draft: { ...draft, prospects, selections, currentPickIndex: nextIndex, complete },
        };
      }),
    advanceDraftPick: () =>
      update((prev) => {
        const draft = prev.draft;
        if (!draft || !draft.started || draft.complete) return prev;
        const nextIndex = draft.currentPickIndex + 1;
        return {
          ...prev,
          draft: { ...draft, currentPickIndex: nextIndex, complete: nextIndex >= draft.order.length },
        };
      }),
    resetDraft: () =>
      update((prev) => ({ ...prev, draft: undefined })),
    resetMorale: () =>
      update((prev) => {
        const baseline = (prev.settings ?? getSettings()).moraleBaseline ?? 50;
        const teams: Record<string, LeagueTeam> = {};
        for (const name of prev.teamOrder) {
          const t = prev.teams[name];
          teams[name] = {
            ...t,
            morale: baseline,
            players: t.players.map((p) => ({ ...p, morale: baseline })),
          };
        }
        return { ...prev, teams };
      }),
    resetLeague: () => update(() => initState()), // routed through update() so a full reset is undoable
    applyRelationDelta: (aiTeam, delta) =>
      update((prev) => {
        if (!prev.teams[aiTeam]) return prev;
        const cur = prev.relations?.[aiTeam];
        const mgr = prev.managers?.[aiTeam];
        const nextVal = nextRelation(cur, delta, mgr);
        return { ...prev, relations: { ...(prev.relations ?? {}), [aiTeam]: nextVal } };
      }),
    applyManagerRespectDelta: (team, delta) =>
      update((prev) => {
        const m = prev.managers?.[team];
        if (!m) return prev;
        const cur = typeof m.respect === "number" ? m.respect : 50;
        const mult = (prev.settings ?? getSettings()).managerRatingVolatility ?? 1;
        // NOTE: sacking is no longer triggered here. AI sackings are decided
        // once per week by the AiSackingWatcher (boardroom review) so respect
        // dips don't automatically fire someone mid-flow.
        const next = clampRespect(cur + delta * mult);
        return { ...prev, managers: { ...prev.managers, [team]: { ...m, respect: next } } };
      }),
    applyPressRespectDelta: (team, delta) =>
      update((prev) => {
        const m = prev.managers?.[team];
        if (!m) return prev;
        const cur = typeof m.respect === "number" ? m.respect : 50;
        // Uses the DEDICATED press-conference volatility multiplier so the
        // user can crank interview stakes without changing weekly match drift.
        const mult = (prev.settings ?? getSettings()).pressConferenceVolatility ?? 1;
        const next = clampRespect(cur + delta * mult);
        return { ...prev, managers: { ...prev.managers, [team]: { ...m, respect: next } } };
      }),
    applyManagerHarshnessSample: (team, sample) =>
      update((prev) => {
        const m = prev.managers?.[team];
        if (!m) return prev;
        const cur = typeof m.harshness === "number" ? m.harshness : 0.5;
        // Slow EMA so a single press conference doesn't yank the mean.
        const next = Math.max(0, Math.min(1, cur * 0.85 + Math.max(0, Math.min(1, sample)) * 0.15));
        return { ...prev, managers: { ...prev.managers, [team]: { ...m, harshness: Math.round(next * 1000) / 1000 } } };
      }),
    applyPlayerMoraleDelta: (team, playerName, delta) =>
      update((prev) => {
        const t = prev.teams[team];
        if (!t) return prev;
        const players = t.players.map((p) =>
          p.name === playerName ? { ...p, morale: clampMorale(p.morale + delta) } : p,
        );
        return { ...prev, teams: { ...prev.teams, [team]: { ...t, players } } };
      }),
    applyTeamMoraleDelta: (team, delta) =>
      update((prev) => {
        const t = prev.teams[team];
        if (!t) return prev;
        return { ...prev, teams: { ...prev.teams, [team]: { ...t, morale: clampMorale(t.morale + delta) } } };
      }),
    appendPressEntry: (entry) =>
      update((prev) => {
        const full: PressArchiveEntry = {
          id: entry.id ?? (typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `press-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          createdAt: entry.createdAt ?? new Date().toISOString(),
          season: entry.season,
          week: entry.week,
          team: entry.team,
          managerName: entry.managerName,
          context: entry.context,
          question: entry.question,
          answer: entry.answer,
          summary: entry.summary,
          targets: entry.targets,
        };
        const prevArchive = prev.pressArchive ?? [];
        const nextArchive = [...prevArchive, full].slice(-500);
        return { ...prev, pressArchive: nextArchive };
      }),
    clearPressArchive: () =>
      update((prev) => ({ ...prev, pressArchive: [] })),
    appendArticleEntry: (entry) =>
      update((prev) => {
        const full: ArticleArchiveEntry = {
          id: entry.id ?? (typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `article-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          createdAt: entry.createdAt ?? new Date().toISOString(),
          season: entry.season,
          week: entry.week,
          kind: entry.kind,
          title: entry.title,
          body: entry.body,
          focus: entry.focus,
        };
        const prevArchive = prev.articleArchive ?? [];
        // Cap at 500 to mirror the press archive so exports stay reasonable.
        const nextArchive = [...prevArchive, full].slice(-500);
        return { ...prev, articleArchive: nextArchive };
      }),
    clearArticleArchive: () =>
      update((prev) => ({ ...prev, articleArchive: [] })),
    appendLeagueEvent: (event) =>
      update((prev) => {
        const full: LeagueEvent = {
          id: event.id ?? (typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          createdAt: event.createdAt ?? new Date().toISOString(),
          season: event.season,
          week: event.week,
          kind: event.kind,
          team: event.team,
          detail: event.detail,
        };
        const prev2 = prev.leagueEvents ?? [];
        return { ...prev, leagueEvents: [...prev2, full].slice(-300) };
      }),
    sackAiManager: (team, reason) =>
      update((prev) => {
        const t = prev.teams[team];
        const m = prev.managers?.[team];
        if (!t || !m) return prev;
        if ((m.personality ?? "").trim().toUpperCase() === "USER CONTROLLED") return prev;
        if (isContractExempt(team)) return prev;
        const clone = { ...t, players: [...t.players] };
        triggerManagerSack(clone);
        const evt: LeagueEvent = {
          id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: new Date().toISOString(),
          season: prev.season,
          week: prev.currentWeek,
          kind: "manager_fired",
          team,
          detail: reason
            ? `${m.name} was sacked by ${team}. Boardroom review: ${reason.slice(0, 160)}`
            : `${m.name} was sacked by ${team} following a boardroom review.`,
        };
        return {
          ...prev,
          teams: { ...prev.teams, [team]: clone },
          managers: { ...prev.managers, [team]: { ...m, respect: 55 } },
          leagueEvents: [...(prev.leagueEvents ?? []), evt].slice(-300),
        };
      }),
    fireAndHireManager: (team, incoming) =>
      update((prev) => {
        const t = prev.teams[team];
        if (!t) return prev;
        const outgoing = prev.managers?.[team];
        const outgoingName = outgoing?.name ?? "the previous manager";
        const baselineMorale = (prev.settings ?? getSettings()).moraleBaseline ?? 60;
        // 1) Reset team + player morale to the configured baseline.
        const players = t.players.map((p) => ({ ...p, morale: baselineMorale }));
        // 2) Reset manager row: new identity, neutral respect, neutral tone.
        const nextManager = {
          ...(outgoing ?? {}),
          name: incoming.name.trim() || outgoingName,
          personality: incoming.personality,
          respect: 50,
          harshness: 0.5,
        } as typeof outgoing extends undefined ? Record<string, unknown> : NonNullable<typeof outgoing>;
        // 3) Wipe every OTHER club's stored relation TOWARD this team so
        //    ratings reset with the new hire.
        const relations = { ...(prev.relations ?? {}) };
        for (const key of Object.keys(relations)) {
          if (key === team || key.includes(team)) delete relations[key];
        }
        // 4) Fire-and-forget wipe of DM history in Supabase for this team.
        //    Non-blocking on purpose — UI updates immediately and the network
        //    call cleans up in the background. If it fails, MessagesSuite's
        //    manual "Clear Archive" button remains available as a fallback.
        try {
          supabase.from("manager_messages").delete().eq("user_team", team).then(() => {}, () => {});
        } catch { /* ignore — offline is fine, local state already reset */ }
        // 5) Log a public league event so press/AI can reference the shake-up.
        const evt: LeagueEvent = {
          id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: new Date().toISOString(),
          season: prev.season,
          week: prev.currentWeek,
          kind: "fire_and_hire",
          team,
          detail: `${team} fired ${outgoingName} and hired ${nextManager.name}.`,
        };
        return {
          ...prev,
          teams: { ...prev.teams, [team]: { ...t, morale: baselineMorale, players } },
          managers: { ...(prev.managers ?? {}), [team]: nextManager },
          relations,
          leagueEvents: [...(prev.leagueEvents ?? []), evt].slice(-300),
        };
      }),
  };

  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}

export function useLeague(): LeagueContextValue {
  const ctx = useContext(LeagueContext);
  if (!ctx) throw new Error("useLeague must be used within LeagueProvider");
  return ctx;
}
