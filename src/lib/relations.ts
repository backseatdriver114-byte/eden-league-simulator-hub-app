// Manager Relations helpers.
// Relations are USER↔AI only (per product spec). One value per AI team,
// representing how warm/cold the user-controlled-side relationship is with
// that AI manager. Range 0-100, baseline configurable in Settings (default 50).
import { settings } from "@/lib/engine-settings";
import type { ManagerRecord } from "@/data/managers";

export function clampRelation(v: number): number {
  if (!Number.isFinite(v)) return settings.relationsBaseline;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

// Personality-driven volatility multiplier for relationship swings. Vivid /
// volatile personalities swing harder; calm / professional ones drift gently.
export function relationVolatilityFor(personality?: string): number {
  const p = (personality ?? "").toLowerCase();
  // Heuristic keyword scan — keeps the math fully deterministic and free.
  if (/(firecracker|loud|toxic|aggressive|fierce|harsh|jumpy|brash|wild|hot[- ]?head|theatrical)/.test(p)) return 1.6;
  if (/(quiet|calm|stoic|humble|polite|laid[- ]?back|jolly|professional|measured|even[- ]?hand)/.test(p)) return 0.6;
  return 1.0;
}

export type RelationBucket = "warm" | "cordial" | "neutral" | "frosty" | "hostile";

export function bucketOf(value: number): RelationBucket {
  if (value >= 75) return "warm";
  if (value >= 60) return "cordial";
  if (value >= 40) return "neutral";
  if (value >= 25) return "frosty";
  return "hostile";
}

export function relationLabel(value: number): string {
  return bucketOf(value).replace(/^./, (c) => c.toUpperCase());
}

// Compute the next value after applying a base delta + personality volatility +
// global Settings volatility. Bounded to 0..100.
export function nextRelation(
  current: number | undefined,
  baseDelta: number,
  manager: ManagerRecord | undefined,
): number {
  const baseline = settings.relationsBaseline;
  const cur = typeof current === "number" ? current : baseline;
  const mult = settings.relationsVolatility * relationVolatilityFor(manager?.personality);
  return clampRelation(cur + baseDelta * mult);
}

// Manager-respect helpers — paired with relations so the press / DM stack can
// use a single import. Respect is a per-manager 0-100 reputation; see
// respect.ts comment for the drift model.
export function clampRespect(v: number): number {
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}
