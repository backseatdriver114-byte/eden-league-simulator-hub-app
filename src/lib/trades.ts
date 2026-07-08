// Eden League AI Trade Negotiation Protocol — faithful TS port of the Python
// reference (player valuation, team utility, fair-deal pre-flight). Used to
// auto-generate weekly trade proposals across the whole league market at once.
import type { DraftPick, LeaguePlayer, LeagueState, LeagueTeam } from "@/state/league";
import { settings } from "@/lib/engine-settings";

// Human-readable label for a draft pick, e.g. "S2 R1 (Socks)".
export function pickLabel(pick: DraftPick): string {
  return `S${pick.season} R${pick.round} (${pick.originalTeam})`;
}

// ---------------- Draft pick valuation ----------------
// Prospect overalls span ~7.4 (the very best) down to ~3.0, with FAR more weak
// prospects than strong ones (an exponential talent curve). The draft order is
// reverse final standings, so a pick's real worth depends on WHERE it is likely
// to land: a strong club's pick lands late (weak prospect left), a weak club's
// pick lands early (access to the rare elite prospects).

const PROSPECT_TOP_OVR = 7.4;
const PROSPECT_BOTTOM_OVR = 3.0;

// Expected overall of the prospect likely available at a given draft slot
// (1-indexed). Convex/exponential decay: a gentle drop among the scarce elites
// up top, then values fall away and bunch up low. slot 1 → ~7.4, last → ~3.0.
export function expectedProspectOvr(slot: number, totalSlots: number): number {
  if (totalSlots <= 1) return PROSPECT_TOP_OVR;
  const k = 0.02; // decay constant tuned so the top ~5 picks sit ~7.4–6.8
  const t = Math.max(1, Math.min(totalSlots, slot)) - 1;
  const end = Math.exp(-k * (totalSlots - 1));
  const norm = (Math.exp(-k * t) - end) / (1 - end); // 1 at slot 1, 0 at last slot
  return Math.round((PROSPECT_BOTTOM_OVR + (PROSPECT_TOP_OVR - PROSPECT_BOTTOM_OVR) * norm) * 10) / 10;
}

// Estimate the overall draft slot a pick is likely to land at, based on the
// ORIGINAL team's current standings rank (1 = top of the table). Reverse
// standings: the worst-ranked club picks first. Round 2 sits a full round later.
export function estimatePickSlot(pick: DraftPick, rank: number, totalTeams: number): number {
  const r = Math.max(1, Math.min(totalTeams, rank));
  const slotInRound = totalTeams - r + 1; // rank 1 (best) → last in round; worst → 1st
  return (pick.round - 1) * totalTeams + slotInRound;
}

// One-line valuation digest for a pick, used in AI briefs.
export function describePickValue(
  pick: DraftPick,
  rank: number,
  totalTeams: number
): string {
  const totalSlots = totalTeams * 2;
  const slot = estimatePickSlot(pick, rank, totalTeams);
  const ovr = expectedProspectOvr(slot, totalSlots);
  return `${pickLabel(pick)} — likely ~pick #${slot} of ${totalSlots} overall (originally ${pick.originalTeam}, currently ranked ${rank}); expected prospect OVR ~${ovr.toFixed(1)}`;
}

// ---------------- Budget parsing / formatting ----------------
// Budgets are stored as display strings like "$21M" / "$24.6M". The algorithm
// works in millions of dollars (numbers).
export function parseBudget(budget: string): number {
  const m = budget.replace(/[^0-9.]/g, "");
  const v = parseFloat(m);
  return Number.isFinite(v) ? v : 0;
}

export function formatBudget(valueM: number): string {
  const rounded = Math.round(valueM * 10) / 10;
  return `$${rounded}M`;
}

// ---------------- Helpers ----------------
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

const ATT_POS = ["ST", "LW", "RW", "Winger"];
const MID_POS = ["CAM", "CM", "CDM", "LM", "RM"];
const DEF_POS = ["CB", "LB", "RB", "LWB", "RWB"];

function countPositions(players: LeaguePlayer[]) {
  const c = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
  for (const p of players) {
    if (p.position === "GK") c.GK++;
    else if (DEF_POS.includes(p.position)) c.DEF++;
    else if (MID_POS.includes(p.position)) c.MID++;
    else if (ATT_POS.includes(p.position)) c.ATT++;
  }
  return c;
}

// ---------------- Positional guardrails ----------------
// Before any automated proposal is surfaced, verify the post-trade roster of
// BOTH clubs would still be able to field a valid lineup. A legal roster keeps:
//   • at least 1 active, uninjured Goalkeeper
//   • at least 11 healthy (non-injured, non-suspended) players
//   • the core tactical spine: >= 2 defenders, >= 2 midfielders, >= 1 attacker
const isHealthy = (p: LeaguePlayer) => p.injuryWeeks === 0 && p.suspensionWeeks === 0;

function isRosterLegal(players: LeaguePlayer[]): boolean {
  const healthy = players.filter(isHealthy);
  if (healthy.length < 11) return false;
  const counts = countPositions(healthy);
  return counts.GK >= 1 && counts.DEF >= 2 && counts.MID >= 2 && counts.ATT >= 1;
}

// Post-trade legality for a single club (sends `out`, receives `incoming`).
function tradeKeepsRosterLegal(team: LeagueTeam, out: LeaguePlayer, incoming: LeaguePlayer): boolean {
  const post = [...team.players.filter((p) => p !== out), incoming];
  return isRosterLegal(post);
}



// ---------------- 2. Mathematical player valuation (V_p) ----------------
export function calculatePlayerValue(p: LeaguePlayer): number {
  let keyAvg: number;
  if (ATT_POS.includes(p.position)) keyAvg = mean([p.FIN, p.DRI, p.PAC]);
  else if (MID_POS.includes(p.position)) keyAvg = mean([p.PAS, p.VIS, p.DRI, p.STA]);
  else if (DEF_POS.includes(p.position)) keyAvg = mean([p.DEF, p.TAC, p.AER, p.STR]);
  else if (p.position === "GK") keyAvg = mean([p.rating, p.COM]);
  else keyAvg = p.rating;

  const ws = p.rating * 0.6 + keyAvg * 0.4;

  let base: number;
  if (ws < 4.0) base = 1.0 + (Math.max(0, ws) / 4.0) * 2.5;
  else if (ws <= 5.5) base = 3.5 + ((ws - 4.0) / 1.5) * 3.0;
  else if (ws <= 7.0) base = 6.5 + ((ws - 5.6) / 1.4) * 5.5;
  else if (ws <= 8.5) base = 12.0 + ((ws - 7.1) / 1.4) * 6.0;
  else base = 18.0 + ((ws - 8.5) / 1.5) * 27.0;

  // ---- Age curve ----
  // Peak market value sits in the early-mid 20s; value tapers as a player ages
  // and a fading veteran is worth meaningfully less than his raw rating implies.
  const age = p.age ?? 27;
  let ageMod: number;
  if (age <= 21) ageMod = 1.08;        // young upside
  else if (age <= 27) ageMod = 1.0;    // prime
  else if (age <= 30) ageMod = 0.9;
  else if (age <= 33) ageMod = 0.78;
  else ageMod = 0.62;                   // ageing veteran

  // ---- Contract length ----
  // Long-term control is an asset; an expiring (or expired) deal is a discount
  // since the buyer must re-sign the player almost immediately.
  const yrs = p.contractYears ?? 1;
  let contractMod: number;
  if (yrs <= 0) contractMod = 0.82;
  else if (yrs === 1) contractMod = 0.92;
  else if (yrs >= 4) contractMod = 1.06;
  else contractMod = 1.0;

  return round1(Math.max(1.0, Math.min(50.0, base * ageMod * contractMod)));
}

// ---------------- 3. Positional shortage & roster balance utility ----------------
// A trade-eligible squad = players not injured/suspended. First 9 = active, rest bench.
interface Squad {
  active: LeaguePlayer[];
  bench: LeaguePlayer[];
  budgetM: number;
}

function buildSquad(team: LeagueTeam): Squad {
  const available = team.players.filter((p) => p.injuryWeeks === 0 && p.suspensionWeeks === 0);
  const ordered = [...available].sort((a, b) => Number(b.starter) - Number(a.starter));
  return {
    active: ordered.slice(0, 9),
    bench: ordered.slice(9),
    budgetM: parseBudget(team.budget),
  };
}

type PosKey = "GK" | "DEF" | "MID" | "ATT";
function groupOf(position: string): PosKey {
  if (position === "GK") return "GK";
  if (DEF_POS.includes(position)) return "DEF";
  if (ATT_POS.includes(position)) return "ATT";
  return "MID";
}

// Minimum healthy depth a club wants per position group before it is "stocked".
const REQUIRED: Record<PosKey, number> = { GK: 2, DEF: 4, MID: 4, ATT: 3 };
// A group this far above requirement is "stacked" — the club won't add more.
const SURPLUS: Record<PosKey, number> = { GK: 3, DEF: 6, MID: 6, ATT: 5 };

function groupCounts(squad: Squad): Record<PosKey, number> {
  const c: Record<PosKey, number> = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
  for (const p of [...squad.active, ...squad.bench]) c[groupOf(p.position)]++;
  return c;
}

function isShortage(squad: Squad, g: PosKey): boolean {
  return groupCounts(squad)[g] < REQUIRED[g];
}
function isSurplus(squad: Squad, g: PosKey): boolean {
  const counts = groupCounts(squad);
  return counts[g] >= SURPLUS[g];
}

function squadUtility(squad: Squad): number {
  const activeRating = sum(squad.active.map((p) => p.rating));
  const benchRating = sum(squad.bench.map((p) => p.rating)) * settings.benchRatingWeight;
  const counts = countPositions([...squad.active, ...squad.bench]);
  let scarcity = 0;
  if (counts.GK < 1) scarcity += 15.0;
  if (counts.DEF < 3) scarcity += 10.0;
  if (counts.ATT < 2) scarcity += 8.0;
  const cashUtility = squad.budgetM * settings.cashUtilityWeight;
  return activeRating + benchRating - scarcity + cashUtility;
}

function tradeUtilityDelta(
  squad: Squad,
  playerOut: LeaguePlayer,
  playerIn: LeaguePlayer,
  cashChange: number
): number {
  const active = squad.active.filter((p) => p !== playerOut);
  const bench = squad.bench.filter((p) => p !== playerOut);
  if (active.length < 9) active.push(playerIn);
  else bench.push(playerIn);
  const after: Squad = { active, bench, budgetM: squad.budgetM + cashChange };
  let delta = squadUtility(after) - squadUtility(squad);

  // ---- Positional Trade Urgency ----
  const inGroup = groupOf(playerIn.position);
  const outGroup = groupOf(playerOut.position);
  // Stacking an already-stocked position the club doesn't need: flat reject.
  if (isSurplus(squad, inGroup) && !isShortage(squad, inGroup) && inGroup !== outGroup) {
    return -100;
  }
  // Active shortage at the incoming player's position: scale the weighting up
  // by 150% so the club is willing to overpay for a missing piece.
  if (isShortage(squad, inGroup) && inGroup !== outGroup) {
    delta *= 1.5;
  }
  // Selling out of a position the club is already short on: penalize.
  if (isShortage(squad, outGroup) && inGroup !== outGroup) {
    delta -= 5;
  }
  return delta;
}

// ---------------- 4. The negotiation loop (global market scan) ----------------
export interface TradeProposal {
  id: string;
  teamA: string;
  teamB: string;
  aSends: string; // player name A sends to B
  bSends: string; // player name B sends to A
  cashAReceives: number; // $M paid by B to A
  cashBReceives: number; // $M paid by A to B
  deltaUA: number;
  deltaUB: number;
  aPickIds?: string[]; // draft pick ids A sends to B
  bPickIds?: string[]; // draft pick ids B sends to A
}


function sample<T>(arr: T[], k: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  const n = Math.min(k, copy.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

// Minimum combined utility gain for a deal to be surfaced to the user. Quality,
// not quantity: any deal clearing this bar is sent to the Trade Suite.
export const UTILITY_THRESHOLD = 4.0;
// Hard safety cap so a pathological week can't flood the desk.
const MAX_SURFACED = 25;

export function generateTradeProposals(state: LeagueState): TradeProposal[] {
  const teams = state.teamOrder.map((name) => state.teams[name]);
  const squads = new Map<string, Squad>();
  for (const t of teams) squads.set(t.name, buildSquad(t));

  const deals: TradeProposal[] = [];
  let counter = 0;

  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const teamA = teams[i];
      const teamB = teams[j];
      const squadA = squads.get(teamA.name)!;
      const squadB = squads.get(teamB.name)!;
      const poolA = [...squadA.active, ...squadA.bench];
      const poolB = [...squadB.active, ...squadB.bench];
      if (!poolA.length || !poolB.length) continue;

      const playersA = sample(poolA, 3);
      const playersB = sample(poolB, 3);

      for (const pA of playersA) {
        for (const pB of playersB) {
          const valA = calculatePlayerValue(pA);
          const valB = calculatePlayerValue(pB);
          // FOR SALE listings make the selling club willing to accept slightly
          // below market — discount their asking value 10% when computing cash.
          const adjValA = pA.forSale ? valA * 0.9 : valA;
          const adjValB = pB.forSale ? valB * 0.9 : valB;
          const diff = adjValA - adjValB;
          const cashA = diff > 0 ? diff : 0; // B pays A
          const cashB = diff < 0 ? -diff : 0; // A pays B

          // Affordability check.
          if (cashA > squadB.budgetM || cashB > squadA.budgetM) continue;

          // Positional guardrails: block any deal that would leave either club
          // unable to field a valid lineup.
          if (!tradeKeepsRosterLegal(teamA, pA, pB)) continue;
          if (!tradeKeepsRosterLegal(teamB, pB, pA)) continue;

          // Cap Lock: salaries travel with players (contract preservation —
          // a traded player KEEPS his salary and years remaining; the new club
          // must absorb them). Block deals that push either club's payroll over
          // the league Hard Salary Cap.
          const cap = state.salaryCap ?? Infinity;
          const curA = teamA.players.reduce((s, p) => s + (p.salary ?? 0), 0);
          const curB = teamB.players.reduce((s, p) => s + (p.salary ?? 0), 0);
          const payA = curA - (pA.salary ?? 0) + (pB.salary ?? 0);
          const payB = curB - (pB.salary ?? 0) + (pA.salary ?? 0);
          // Block only deals that push a club OVER the cap. A club already above
          // the cap may still trade as long as the deal doesn't raise its payroll.
          if (payA > cap + 0.001 && payA > curA + 0.001) continue;
          if (payB > cap + 0.001 && payB > curB + 0.001) continue;


          let deltaUA = tradeUtilityDelta(squadA, pA, pB, cashA - cashB);
          let deltaUB = tradeUtilityDelta(squadB, pB, pA, cashB - cashA);
          // FOR SALE bonus: surfaces deals that move listed players. Both sides
          // get a small bump — the buyer because the asking price is softer, the
          // seller because they've signaled they want to move the player.
          if (pB.forSale) deltaUA += 3;
          if (pA.forSale) deltaUB += 3;


          if (deltaUA > 0 && deltaUB > 0) {
            deals.push({
              id: `tp-${state.season}-w${state.currentWeek}-${counter++}`,
              teamA: teamA.name,
              teamB: teamB.name,
              aSends: pA.name,
              bSends: pB.name,
              cashAReceives: round1(cashA),
              cashBReceives: round1(cashB),
              deltaUA: round2(deltaUA),
              deltaUB: round2(deltaUB),
            });
          }
        }
      }
    }
  }

  // Surface the best deals, ranked by combined utility (best first, capped).
  // No utility threshold — the Trade Suite shows the top deals and lets the
  // user reveal more lower-ranked deals on demand.
  deals.sort((a, b) => b.deltaUA + b.deltaUB - (a.deltaUA + a.deltaUB));
  return deals.slice(0, MAX_SURFACED);
}

// ---------------- 5. Pre-flight validation (shared by manual + accept) ----------------
// Returns a human-readable reason why a trade cannot go through, or null when
// the deal is legal. Mirrors the exact guards inside the state engine so the
// UI can explain a rejection instead of failing silently.
export function tradeBlockReason(
  state: LeagueState,
  aName: string,
  bName: string,
  aPlayers: string[],
  bPlayers: string[],
  cashAReceives: number, // $M paid by B to A
  cashBReceives: number,  // $M paid by A to B
  aPickIds: string[] = [], // draft pick ids A sends to B
  bPickIds: string[] = []  // draft pick ids B sends to A
): string | null {
  if (aName === bName) return "Pick two different clubs.";
  const teamA = state.teams[aName];
  const teamB = state.teams[bName];
  if (!teamA || !teamB) return "Unknown club selected.";

  // ---- Transfer window: no deals may complete once the window has closed ----
  const lastWk = state.settings?.transferWindowLastWeek ?? 12;
  if ((state.currentWeek ?? 1) > lastWk) {
    return `Transfer window closed — deals only complete through Week ${lastWk}. It reopens next season.`;
  }


  // ---- Draft-pick ownership: a club can only trade picks it currently owns ----
  const picks = state.draftPicks ?? [];
  for (const id of aPickIds) {
    const pk = picks.find((p) => p.id === id);
    if (!pk || pk.owner !== aName) return `${aName} no longer owns one of the selected draft picks.`;
  }
  for (const id of bPickIds) {
    const pk = picks.find((p) => p.id === id);
    if (!pk || pk.owner !== bName) return `${bName} no longer owns one of the selected draft picks.`;
  }
  for (const id of aPickIds) {
    if (bPickIds.includes(id)) return "A draft pick can't be on both sides of the trade.";
  }

  // ---- Affordability: a club cannot spend cash it doesn't have ----
  const aBudget = parseBudget(teamA.budget);
  const bBudget = parseBudget(teamB.budget);
  const aAfter = aBudget + cashAReceives - cashBReceives;
  const bAfter = bBudget + cashBReceives - cashAReceives;
  if (bAfter < -0.001) {
    return `${bName} doesn't have the capital for this deal — it holds ${formatBudget(bBudget)} but would need to pay ${formatBudget(cashAReceives)}.`;
  }
  if (aAfter < -0.001) {
    return `${aName} doesn't have the capital for this deal — it holds ${formatBudget(aBudget)} but would need to pay ${formatBudget(cashBReceives)}.`;
  }

  // ---- Cap Lock: salaries travel with players ----
  const cap = state.salaryCap ?? Infinity;
  const aSet = new Set(aPlayers.filter(Boolean));
  const bSet = new Set(bPlayers.filter(Boolean));
  const salarySum = (ps: LeaguePlayer[]) => ps.reduce((s, p) => s + (p.salary ?? 0), 0);
  const outA = teamA.players.filter((p) => aSet.has(p.name));
  const outB = teamB.players.filter((p) => bSet.has(p.name));

  // ---- Player-list integrity ----
  // A player can't be on both sides, and every named player must actually exist
  // on the club sending them (a typo'd name would silently become a cash deal).
  for (const n of aSet) {
    if (bSet.has(n)) return `${n} can't be on both sides of the trade.`;
  }
  if (outA.length < aSet.size) return `One or more selected players are not on ${aName}'s roster.`;
  if (outB.length < bSet.size) return `One or more selected players are not on ${bName}'s roster.`;

  // ---- Fieldability: neither club may drop below 9 healthy players ----
  // (the simulation engine cannot field a legal lineup under 9 available players).
  const healthyCount = (players: LeaguePlayer[], out: Set<string>, incoming: LeaguePlayer[]) =>
    players.filter((p) => !out.has(p.name) && p.injuryWeeks === 0 && p.suspensionWeeks === 0).length +
    incoming.filter((p) => p.injuryWeeks === 0 && p.suspensionWeeks === 0).length;
  if (healthyCount(teamA.players, aSet, outB) < 9) {
    return `${aName} would be left with fewer than 9 available players and couldn't field a team.`;
  }
  if (healthyCount(teamB.players, bSet, outA) < 9) {
    return `${bName} would be left with fewer than 9 available players and couldn't field a team.`;
  }

  const curA = salarySum(teamA.players);
  const curB = salarySum(teamB.players);
  const payA = curA - salarySum(outA) + salarySum(outB);
  const payB = curB - salarySum(outB) + salarySum(outA);
  if (payA > cap + 0.001 && payA > curA + 0.001) {
    return `Blocked by the $${cap}M hard salary cap: ${aName}'s payroll would rise from $${round1(curA)}M to $${round1(payA)}M.`;
  }
  if (payB > cap + 0.001 && payB > curB + 0.001) {
    return `Blocked by the $${cap}M hard salary cap: ${bName}'s payroll would rise from $${round1(curB)}M to $${round1(payB)}M.`;
  }

  return null;
}

// ---------------- AI trade engine helpers ----------------
// Build a factual digest of the ENTIRE league market (all rosters, ratings,
// values, positions, contracts, salaries, budgets, cap) for the AI proposal
// generator. Every number is real — derived strictly from league state.
function aiRosterLines(team: LeagueTeam): string {
  return team.players
    .map((p) => {
      const status =
        p.injuryWeeks > 0 ? ` [injured]`
        : p.suspensionWeeks > 0 ? ` [suspended]`
        : "";
      const listed = p.forSale ? ` [FOR SALE — actively being shopped, more willing to move]` : "";
      return `    - ${p.name} (${p.position}, age ${p.age}, rating ${p.rating.toFixed(1)}, value $${calculatePlayerValue(p)}M, ${p.contractYears}yr @ $${p.salary}M)${status}${listed}`;
    })
    .join("\n");
}

export function buildTradeMarketBrief(
  state: LeagueState,
  excludeTeams: string[] = [],
  rankOf?: (team: string) => number
): string {
  const cap = state.salaryCap ?? 0;
  const exclude = new Set(excludeTeams);
  const totalTeams = state.teamOrder.length;
  const rank = (team: string) => {
    const r = rankOf?.(team);
    return r && r > 0 ? r : Math.ceil(totalTeams / 2); // unknown → mid-table
  };
  const lines: string[] = [
    `SALARY CAP: $${cap}M hard cap (a club's total payroll cannot exceed this after a trade).`,
    `CURRENT SEASON ${state.season}, WEEK ${state.currentWeek}.`,
    ``,
  ];
  for (const name of state.teamOrder) {
    if (exclude.has(name)) continue;
    const t = state.teams[name];
    if (!t) continue;
    const payroll = Math.round(t.players.reduce((s, p) => s + (p.salary ?? 0), 0) * 10) / 10;
    const ownedPickLines = (state.draftPicks ?? [])
      .filter((pk) => pk.owner === name)
      .map((pk) => describePickValue(pk, rank(pk.originalTeam), totalTeams));
    lines.push(
      `${name} — style "${t.tactical_style}", transfer budget ${t.budget}, payroll $${payroll}M:`,
      aiRosterLines(t),
      `    draft picks owned:${ownedPickLines.length ? "\n      " + ownedPickLines.join("\n      ") : " none"}`,
      ``
    );
  }
  lines.push(
    `Note: player "value" is the league's fair-market valuation in $M. A fair deal trades players of similar combined value, with cash bridging any gap.`,
    `FOR SALE: Players tagged [FOR SALE] are actively being shopped by their club — those clubs are more willing to move them at slightly under market value. Prefer surfacing deals that include a FOR SALE player when one fits the buyer's needs.`,
    `DRAFT PICK VALUATION: Prospect overalls run from ~7.4 (the rare elites) down to ~3.0, with FAR more weak prospects than strong ones. The draft uses reverse standings, so judge a pick by its LIKELY slot, not just that it is a pick: an early pick (from a weak club) can land a 7.0+ talent and is genuinely valuable, while a late pick (from a strong club) will likely yield a sub-5.0 prospect and is worth little. A typical mid pick is worth roughly the value of a low-rated bench player. Picks are especially attractive to budget-strapped clubs because every rookie signs a cheap $2M/2yr deal. Weigh each pick's expected prospect OVR (shown above) against the players in the deal.`
  );
  return lines.join("\n");
}

// Validate a single AI-proposed deal against ALL existing safety guards and,
// if legal, return a complete TradeProposal (with locally-computed utility
// deltas). Returns null for any illegal / hallucinated deal.
export function buildProposalFromTerms(
  state: LeagueState,
  teamA: string,
  teamB: string,
  aSends: string,
  bSends: string,
  cashAReceives: number,
  cashBReceives: number,
  idSuffix: string | number
): TradeProposal | null {
  const ta = state.teams[teamA];
  const tb = state.teams[teamB];
  if (!ta || !tb || teamA === teamB) return null;

  const pA = ta.players.find((p) => p.name === aSends);
  const pB = tb.players.find((p) => p.name === bSends);
  if (!pA || !pB) return null;

  const cashA = Math.max(0, round1(cashAReceives) || 0);
  const cashB = Math.max(0, round1(cashBReceives) || 0);

  const reason = tradeBlockReason(state, teamA, teamB, [aSends], [bSends], cashA, cashB);
  if (reason) return null;

  const squadA = buildSquad(ta);
  const squadB = buildSquad(tb);
  const deltaUA = tradeUtilityDelta(squadA, pA, pB, cashA - cashB);
  const deltaUB = tradeUtilityDelta(squadB, pB, pA, cashB - cashA);

  return {
    id: `tp-ai-${state.season}-w${state.currentWeek}-${idSuffix}`,
    teamA,
    teamB,
    aSends,
    bSends,
    cashAReceives: cashA,
    cashBReceives: cashB,
    deltaUA: round2(deltaUA),
    deltaUB: round2(deltaUB),
  };
}

// Validate a draft-time AI proposal that may include players, draft picks, and
// cash on either side. Resolves pick labels to ids the sending club actually
// owns. Returns a complete TradeProposal, or null if anything is illegal /
// hallucinated. Player/cash legality reuses tradeBlockReason; picks are pure
// ownership transfers (no roster/cap impact).
export function buildAiPickProposal(
  state: LeagueState,
  teamA: string,
  teamB: string,
  aSends: string,
  bSends: string,
  aPickLabels: string[],
  bPickLabels: string[],
  cashAReceives: number,
  cashBReceives: number,
  idSuffix: string | number
): TradeProposal | null {
  const ta = state.teams[teamA];
  const tb = state.teams[teamB];
  if (!ta || !tb || teamA === teamB) return null;

  // Players are optional in a draft deal, but any named player must exist.
  const aPlayers = aSends ? [aSends] : [];
  const bPlayers = bSends ? [bSends] : [];
  if (aSends && !ta.players.some((p) => p.name === aSends)) return null;
  if (bSends && !tb.players.some((p) => p.name === bSends)) return null;

  // Resolve pick labels to ids the sending club currently owns.
  const resolvePicks = (owner: string, labels: string[]): string[] | null => {
    const ids: string[] = [];
    for (const label of labels) {
      const pk = (state.draftPicks ?? []).find(
        (p) => p.owner === owner && pickLabel(p) === label
      );
      if (!pk) return null; // hallucinated or not owned
      if (ids.includes(pk.id)) return null; // duplicate
      ids.push(pk.id);
    }
    return ids;
  };
  const aPickIds = resolvePicks(teamA, aPickLabels);
  const bPickIds = resolvePicks(teamB, bPickLabels);
  if (aPickIds === null || bPickIds === null) return null;

  const cashA = Math.max(0, round1(cashAReceives) || 0);
  const cashB = Math.max(0, round1(cashBReceives) || 0);

  // Must move at least one asset.
  if (!aPlayers.length && !bPlayers.length && !aPickIds.length && !bPickIds.length && cashA === 0 && cashB === 0) {
    return null;
  }

  // Player/cash legality (picks are exempt from roster/cap checks).
  const reason = tradeBlockReason(state, teamA, teamB, aPlayers, bPlayers, cashA, cashB);
  if (reason) return null;

  // Utility delta only applies to player swaps; informational only here.
  let deltaUA = 0;
  let deltaUB = 0;
  const pA = aSends ? ta.players.find((p) => p.name === aSends) : undefined;
  const pB = bSends ? tb.players.find((p) => p.name === bSends) : undefined;
  if (pA && pB) {
    const squadA = buildSquad(ta);
    const squadB = buildSquad(tb);
    deltaUA = tradeUtilityDelta(squadA, pA, pB, cashA - cashB);
    deltaUB = tradeUtilityDelta(squadB, pB, pA, cashB - cashA);
  }

  return {
    id: `tp-draft-${state.season}-${idSuffix}`,
    teamA,
    teamB,
    aSends,
    bSends,
    cashAReceives: cashA,
    cashBReceives: cashB,
    deltaUA: round2(deltaUA),
    deltaUB: round2(deltaUB),
    aPickIds,
    bPickIds,
  };
}


