// Aging & The Experience Shift.
// Players carry an Age. On ingest, age is inferred from a physical-to-mental
// attribute ratio. Each offseason, veterans (30+) regress physically and
// progress mentally; players who decay past a threshold or hit 35 retire and
// are replaced by a fresh 17-year-old academy prospect.
import type { LeaguePlayer } from "@/state/league";
import { computeOverall } from "@/lib/ratings";

const rand = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const mean = (a: number[]) => (a.length === 0 ? 0 : a.reduce((s, v) => s + v, 0) / a.length);

// Physical-to-mental ratio classification → starting age band.
export function computeStartingAge(p: LeaguePlayer): number {
  const physical = mean([p.PAC, p.STA]);
  const mental = mean([p.VIS, p.COM, p.POS_attr]);
  const ratio = mental === 0 ? 2 : physical / mental;
  if (ratio >= 1.15) return rand(18, 23); // Prospect
  if (ratio <= 0.95) return rand(30, 34); // Veteran
  return rand(24, 29); // Prime
}

// Retirement is a fully MANUAL decision — there are no automatic age/decay
// cutoffs. Aging only shifts attributes (youth growth, veteran shift); players
// are only ever removed from a roster via the "Remove Player" control.

export interface AgingResult {
  player: LeaguePlayer;
  retired: boolean; // always false now — kept for call-site compatibility
  veteranFulfilled: boolean; // hit max mental progression this offseason
  replacement?: LeaguePlayer;
}

// Pools used to give every academy prospect a unique, identifiable name. Names
// are used as identifiers across lineups/leaderboards, so duplicates would
// collide — combine a random name with a unique numeric suffix.
const PROSPECT_FIRST = [
  "Theo", "Luka", "Mateo", "Kai", "Noah", "Eli", "Arlo", "Rio", "Zane", "Cody",
  "Finn", "Jude", "Levi", "Remy", "Cruz", "Ezra", "Niko", "Dario", "Sami", "Tomas",
];
const PROSPECT_LAST = [
  "Vega", "Bauer", "Reyes", "Castro", "Mensah", "Okafor", "Sato", "Lindqvist",
  "Moreau", "Petrov", "Haaland", "Diallo", "Costa", "Nakamura", "Ferreira",
  "Andersen", "Kovac", "Esposito", "Marsh", "Volkov",
];
let prospectCounter = 0;
function uniqueProspectName(): string {
  const first = PROSPECT_FIRST[rand(0, PROSPECT_FIRST.length - 1)];
  const last = PROSPECT_LAST[rand(0, PROSPECT_LAST.length - 1)];
  prospectCounter += 1;
  // Suffix guarantees uniqueness even if the random pick repeats.
  return `${first} ${last} #${prospectCounter}${rand(10, 99)}`;
}

// Generate a fresh 17-year-old baseline prospect to replace a retiree.
export function youthProspect(position: string): LeaguePlayer {
  const base: LeaguePlayer = {
    name: uniqueProspectName(),
    position,
    starter: false,
    age: 17,
    morale: 50,
    injuryWeeks: 0,
    suspensionWeeks: 0,
    reservedSlot: null,
    yellowLog: [],
    salary: 5.0,
    contractYears: 2,
    rating: 5.0, FIN: 5.0, SHO: 5.0, PAS: 4.5, VIS: 4.5, DRI: 5.5,
    PAC: 6.5, STA: 6.5, DEF: 5.0, TAC: 5.0, POS_attr: 4.0, COM: 4.0,
    WR: 5.5, AGG: 5.0, STR: 5.0, AER: 5.0,
  };
  return { ...base, rating: computeOverall(base) };
}

// Advance one offseason for a single player. Returns updated player (rating
// recomputed) and veteran-fulfilment status. Never retires a player.
export function ageOnePlayer(p: LeaguePlayer): AgingResult {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const age = (p.age ?? 25) + 1;
  let next: LeaguePlayer = { ...p, age };
  let veteranFulfilled = false;

  if (age <= 23) {
    // Youth development — young players grow into their potential. Physical and
    // technical attributes rise (steeper the younger they are), mental traits
    // tick up a little with experience.
    const phys = age <= 20 ? 0.35 : 0.2;
    const tech = age <= 20 ? 0.4 : 0.25;
    next.PAC = r1(Math.min(10.0, next.PAC + phys));
    next.STA = r1(Math.min(10.0, next.STA + phys));
    next.DRI = r1(Math.min(10.0, next.DRI + tech));
    next.PAS = r1(Math.min(10.0, next.PAS + tech * 0.7));
    next.FIN = r1(Math.min(10.0, next.FIN + tech * 0.6));
    next.DEF = r1(Math.min(10.0, next.DEF + tech * 0.6));
    next.TAC = r1(Math.min(10.0, next.TAC + tech * 0.6));
    next.VIS = r1(Math.min(10.0, next.VIS + 0.15));
    next.POS_attr = r1(Math.min(10.0, next.POS_attr + 0.15));
  } else if (age >= 30) {
    // Physical regression — exponential decline of PAC & STA.
    const decay = 1 - Math.pow(1.12, age - 29) * 0.04; // steeper each year
    const factor = Math.max(0.7, decay);
    next.PAC = Math.max(1.0, r1(next.PAC * factor));
    next.STA = Math.max(1.0, r1(next.STA * factor));

    // Mental progression — VIS, POS_attr, COM rise with experience.
    const gain = 0.3;
    const before = next.VIS + next.POS_attr + next.COM;
    next.VIS = Math.min(10.0, r1(next.VIS + gain));
    next.POS_attr = Math.min(10.0, r1(next.POS_attr + gain));
    next.COM = Math.min(10.0, r1(next.COM + gain));
    // Veteran fulfillment when mental attributes reach the ceiling.
    if (next.VIS >= 10 && next.POS_attr >= 10 && next.COM >= 10 && before < 30) {
      veteranFulfilled = true;
    }
  }

  next.rating = computeOverall(next);

  // Retirement is manual only — always return retired:false.
  return { player: next, retired: false, veteranFulfilled };
}

