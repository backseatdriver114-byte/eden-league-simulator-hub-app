import type { LeaguePlayer } from "@/state/league";

// Maps friendly attribute words AND raw codes to the LeaguePlayer numeric key.
const ATTR_ALIASES: Record<string, keyof LeaguePlayer> = {
  ovr: "rating", overall: "rating", rating: "rating",
  pac: "PAC", pace: "PAC", speed: "PAC",
  fin: "FIN", finishing: "FIN", finish: "FIN",
  sho: "SHO", shooting: "SHO", shot: "SHO",
  pas: "PAS", passing: "PAS", pass: "PAS",
  vis: "VIS", vision: "VIS",
  dri: "DRI", dribbling: "DRI", dribble: "DRI",
  sta: "STA", stamina: "STA",
  def: "DEF", defending: "DEF", defense: "DEF", defence: "DEF",
  tac: "TAC", tackling: "TAC", tackle: "TAC",
  pos: "POS_attr", positioning: "POS_attr", position: "POS_attr",
  com: "COM", composure: "COM",
  wr: "WR", workrate: "WR", work: "WR",
  agg: "AGG", aggression: "AGG",
  str: "STR", strength: "STR", strong: "STR",
  aer: "AER", aerial: "AER", heading: "AER", header: "AER",
  // meta numeric fields (item 8.1)
  age: "age", salary: "salary", wage: "salary",
  contract: "contractYears", years: "contractYears", yrs: "contractYears",
  morale: "morale",
};

// Concrete positions the engine understands.
const KNOWN_POSITIONS = new Set([
  "GK", "ST", "LW", "RW", "CAM", "CM", "CDM", "LM", "RM",
  "CB", "LB", "RB", "LWB", "RWB",
]);

// Group aliases: a token like "WINGER" matches ANY position in its set.
// Solves item 8.2 — "winger" no longer requires LW/RW exactly.
const POSITION_GROUPS: Record<string, string[]> = {
  WINGER: ["LW", "RW"],
  WINGERS: ["LW", "RW"],
  WING: ["LW", "RW"],
  FULLBACK: ["LB", "RB", "LWB", "RWB"],
  FULLBACKS: ["LB", "RB", "LWB", "RWB"],
  FB: ["LB", "RB", "LWB", "RWB"],
  OUTSIDEBACK: ["LB", "RB", "LWB", "RWB"],
  WINGBACK: ["LWB", "RWB"],
  WINGBACKS: ["LWB", "RWB"],
  MIDFIELDER: ["CAM", "CM", "CDM", "LM", "RM"],
  MIDFIELDERS: ["CAM", "CM", "CDM", "LM", "RM"],
  MIDFIELD: ["CAM", "CM", "CDM", "LM", "RM"],
  MID: ["CAM", "CM", "CDM", "LM", "RM"],
  DEFENDER: ["CB", "LB", "RB", "LWB", "RWB"],
  DEFENDERS: ["CB", "LB", "RB", "LWB", "RWB"],
  DEFENSE: ["CB", "LB", "RB", "LWB", "RWB"],
  DEFENCE: ["CB", "LB", "RB", "LWB", "RWB"],
  CENTREBACK: ["CB"],
  CENTERBACK: ["CB"],
  ATTACKER: ["ST", "LW", "RW"],
  ATTACKERS: ["ST", "LW", "RW"],
  FORWARD: ["ST", "LW", "RW"],
  FORWARDS: ["ST", "LW", "RW"],
  STRIKER: ["ST"],
  STRIKERS: ["ST"],
  GOALKEEPER: ["GK"],
  KEEPER: ["GK"],
};

// Friendly single-position aliases (still resolved against KNOWN_POSITIONS).
const POSITION_ALIASES: Record<string, string> = {
  leftwing: "LW", lw: "LW", rightwing: "RW", rw: "RW",
  st: "ST", cm: "CM", cam: "CAM", attackingmid: "CAM", cdm: "CDM", defensivemid: "CDM",
  cb: "CB", leftback: "LB", lb: "LB", rightback: "RB", rb: "RB",
  gk: "GK",
};

type Op = ">" | ">=" | "<" | "<=" | "=";
interface Comparison { key: keyof LeaguePlayer; op: Op; value: number; }

// Categorical / boolean predicates the user can stack with the numeric ones.
export type StatusKey = "INJURED" | "SUSPENDED" | "HEALTHY" | "FORSALE" | "STARTER" | "EXPIRING";

export interface ParsedQuery {
  nameTerms: string[];
  // Either a single position or a group (set of positions). When `positionSet`
  // is populated it takes precedence over `position`.
  position?: string;
  positionSet?: string[];
  comparisons: Comparison[];
  statuses: StatusKey[];
  isEmpty: boolean;
}

const STATUS_TOKENS: Record<string, StatusKey> = {
  injured: "INJURED",
  injury: "INJURED",
  suspended: "SUSPENDED",
  susp: "SUSPENDED",
  healthy: "HEALTHY",
  fit: "HEALTHY",
  forsale: "FORSALE",
  sale: "FORSALE",
  listed: "FORSALE",
  starter: "STARTER",
  starting: "STARTER",
  expiring: "EXPIRING",
  expire: "EXPIRING",
};

export function parseSearchQuery(raw: string): ParsedQuery {
  // Normalise commas/semicolons to spaces. Also collapse "FOR SALE" / "for-sale"
  // into a single FORSALE token before we tokenize, and the same for
  // HEALTH = INJURED style filters.
  let q = raw.trim().replace(/[,;]+/g, " ");
  q = q.replace(/\bfor[\s-]+sale\b/gi, " FORSALE ");
  q = q.replace(/\bhealth\s*=\s*(injured|suspended|healthy|fit)\b/gi, (_m, v) => ` ${String(v)} `);
  // "contract = expiring" → expiring
  q = q.replace(/\bcontract\s*=\s*expiring\b/gi, " expiring ");

  const comparisons: Comparison[] = [];
  // Extract "<attr> <op> <number>" patterns.
  const cmpRe = /([a-zA-Z_]+)\s*(>=|<=|=|>|<)\s*(\d+(?:\.\d+)?)/g;
  q = q.replace(cmpRe, (full, word: string, op: string, num: string) => {
    const key = ATTR_ALIASES[word.toLowerCase()];
    if (key) {
      comparisons.push({ key, op: op as Op, value: parseFloat(num) });
      return " ";
    }
    return full;
  });

  let position: string | undefined;
  let positionSet: string[] | undefined;
  const nameTerms: string[] = [];
  const statuses: StatusKey[] = [];

  for (const tok of q.split(/\s+/).map((t) => t.trim()).filter(Boolean)) {
    const upper = tok.toUpperCase();
    const lower = tok.toLowerCase();

    // explicit pos:XX
    const m = tok.match(/^pos:(.+)$/i);
    if (m) {
      const v = m[1].toUpperCase();
      if (POSITION_GROUPS[v]) positionSet = POSITION_GROUPS[v];
      else position = v;
      continue;
    }
    // status / categorical token
    const status = STATUS_TOKENS[lower] ?? (upper === "FORSALE" ? "FORSALE" : undefined);
    if (status) { statuses.push(status); continue; }
    // group token
    if (POSITION_GROUPS[upper]) { positionSet = POSITION_GROUPS[upper]; continue; }
    // single position
    if (KNOWN_POSITIONS.has(upper)) { position = upper; continue; }
    if (POSITION_ALIASES[lower]) { position = POSITION_ALIASES[lower]; continue; }
    nameTerms.push(lower);
  }

  return {
    nameTerms,
    position,
    positionSet,
    comparisons,
    statuses,
    isEmpty:
      nameTerms.length === 0 && !position && !positionSet &&
      comparisons.length === 0 && statuses.length === 0,
  };
}

function cmpOk(actual: number, op: Op, value: number): boolean {
  switch (op) {
    case ">": return actual > value;
    case ">=": return actual >= value;
    case "<": return actual < value;
    case "<=": return actual <= value;
    case "=": return Math.abs(actual - value) < 0.0001;
  }
}

function statusOk(p: LeaguePlayer, s: StatusKey): boolean {
  switch (s) {
    case "INJURED": return p.injuryWeeks > 0;
    case "SUSPENDED": return p.suspensionWeeks > 0;
    case "HEALTHY": return p.injuryWeeks === 0 && p.suspensionWeeks === 0;
    case "FORSALE": return !!p.forSale;
    case "STARTER": return !!p.starter;
    case "EXPIRING": return (p.contractYears ?? 0) <= 1;
  }
}

export function playerMatchesQuery(p: LeaguePlayer, parsed: ParsedQuery): boolean {
  const name = p.name.toLowerCase();
  if (parsed.nameTerms.some((t) => !name.includes(t))) return false;
  const pos = p.position.toUpperCase();
  if (parsed.positionSet && !parsed.positionSet.includes(pos)) return false;
  if (parsed.position && pos !== parsed.position) return false;
  for (const c of parsed.comparisons) {
    const actual = Number(p[c.key]);
    if (!Number.isFinite(actual) || !cmpOk(actual, c.op, c.value)) return false;
  }
  for (const s of parsed.statuses) {
    if (!statusOk(p, s)) return false;
  }
  return true;
}
