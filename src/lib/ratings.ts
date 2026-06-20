// Overall Rating Automation.
// A player's OVR ("rating") is a position-weighted average of their attribute
// ratings, rounded to one decimal. It is recomputed every time an attribute
// changes and is never edited directly by the user.
import type { LeaguePlayer } from "@/state/league";

type AttrField = Exclude<keyof LeaguePlayer, "name" | "position" | "starter" | "injuryWeeks" | "suspensionWeeks" | "rating" | "yellowLog">;

type WeightMap = Partial<Record<AttrField, number>>;

const ATTACKER: WeightMap = {
  FIN: 0.30, SHO: 0.20, POS_attr: 0.15, PAC: 0.10, DRI: 0.10, COM: 0.05, PAS: 0.05, AER: 0.05,
};
const WINGER: WeightMap = {
  DRI: 0.25, PAC: 0.20, FIN: 0.15, SHO: 0.10, PAS: 0.10, VIS: 0.10, WR: 0.10,
};
const CAM: WeightMap = {
  VIS: 0.25, PAS: 0.25, DRI: 0.15, FIN: 0.10, SHO: 0.10, COM: 0.10, PAC: 0.05,
};
const CENTRAL_MID: WeightMap = {
  PAS: 0.25, VIS: 0.20, STA: 0.15, DRI: 0.10, DEF: 0.10, TAC: 0.10, WR: 0.10,
};
const CDM: WeightMap = {
  DEF: 0.20, TAC: 0.20, PAS: 0.20, VIS: 0.15, POS_attr: 0.15, STR: 0.10,
};
const CENTER_BACK: WeightMap = {
  DEF: 0.30, TAC: 0.25, POS_attr: 0.15, STR: 0.15, AER: 0.10, PAC: 0.05,
};
const FULL_BACK: WeightMap = {
  DEF: 0.20, TAC: 0.20, PAC: 0.20, STA: 0.15, WR: 0.15, PAS: 0.10,
};
const GOALKEEPER: WeightMap = {
  COM: 0.30, POS_attr: 0.25, DEF: 0.20, AER: 0.10, PAS: 0.10, VIS: 0.05,
};
const BALANCED: WeightMap = {
  FIN: 0.07, SHO: 0.07, PAS: 0.07, VIS: 0.07, DRI: 0.07, PAC: 0.07, STA: 0.07,
  DEF: 0.07, TAC: 0.07, POS_attr: 0.07, COM: 0.07, WR: 0.07, AGG: 0.05, STR: 0.05, AER: 0.05,
};

function weightsFor(position: string): WeightMap {
  const pos = position.toUpperCase().trim();
  if (pos === "GK") return GOALKEEPER;
  if (["ST", "CF"].includes(pos)) return ATTACKER;
  if (["LW", "RW", "WINGER"].includes(pos)) return WINGER;
  if (pos === "CAM") return CAM;
  if (pos === "CDM") return CDM;
  if (["CM", "LM", "RM"].includes(pos)) return CENTRAL_MID;
  if (["CB"].includes(pos)) return CENTER_BACK;
  if (["LB", "RB", "LWB", "RWB", "FB"].includes(pos)) return FULL_BACK;
  return BALANCED;
}

export function computeOverall(p: LeaguePlayer): number {
  const w = weightsFor(p.position);
  let total = 0;
  let weightSum = 0;
  for (const key in w) {
    const field = key as AttrField;
    const weight = w[field] ?? 0;
    const value = (p[field] as number) ?? 0;
    total += value * weight;
    weightSum += weight;
  }
  if (weightSum === 0) return p.rating;
  return Math.round((total / weightSum) * 10) / 10;
}
