// Day-of-week scheduling helpers. The Eden League now runs 12 games per week
// spread across 4 days: 2 Mon, 3 Wed, 1 Fri (marquee), 6 Sat.
// (Tue/Thu/Sun always empty.)
import type { LeagueState, FixtureEntry, StandingRow } from "@/state/league";

export type MatchDay = "MON" | "WED" | "FRI" | "SAT";

export const MATCH_DAYS: MatchDay[] = ["MON", "WED", "FRI", "SAT"];
export const DAY_QUOTA: Record<MatchDay, number> = { MON: 2, WED: 3, FRI: 1, SAT: 6 };
export const DAY_ORDER: Record<MatchDay, number> = { MON: 0, WED: 1, FRI: 2, SAT: 3 };
export const DAY_LABEL: Record<MatchDay, string> = {
  MON: "Monday", WED: "Wednesday", FRI: "Friday (Marquee)", SAT: "Saturday",
};

// Compute per-day counts within a week.
export function countByDay(fixtures: { day?: MatchDay | null }[]): Record<MatchDay, number> {
  const out: Record<MatchDay, number> = { MON: 0, WED: 0, FRI: 0, SAT: 0 };
  for (const fx of fixtures) if (fx.day && out[fx.day] != null) out[fx.day]++;
  return out;
}

// Which days in this week are over-quota? Returns [] when balanced.
export function overQuotaDays(fixtures: { day?: MatchDay | null }[]): MatchDay[] {
  const counts = countByDay(fixtures);
  return MATCH_DAYS.filter((d) => counts[d] > DAY_QUOTA[d]);
}

// Pick a Friday marquee fixture from a week's fixtures. Heuristic per user:
// use standings; prefer closest-in-standings and highest-in-table. If no
// standings yet, fall back to highest combined roster OVR.
export function pickMarqueeFixture<T extends { home: string; away: string }>(
  fixtures: T[],
  standings: StandingRow[],
  teamStrength?: (name: string) => number,
): T | null {
  if (fixtures.length === 0) return null;
  const rankOf = (t: string) => standings.find((r) => r.team === t)?.rank ?? 99;
  const scored = fixtures.map((f) => {
    const rh = rankOf(f.home);
    const ra = rankOf(f.away);
    if (standings.length > 0) {
      const closeness = 30 - Math.abs(rh - ra); // higher = closer
      const height = 60 - (rh + ra); // higher = both near top
      return { fx: f, score: closeness * 1.5 + height };
    }
    const s = teamStrength
      ? teamStrength(f.home) + teamStrength(f.away)
      : Math.random();
    return { fx: f, score: s };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].fx;
}

// Assign each fixture in a week to a day per DAY_QUOTA. Friday goes to the
// marquee pick. The rest are distributed to fill each day up to its quota.
export function assignDaysForWeek<T extends { home: string; away: string; day?: MatchDay | null }>(
  weekFixtures: T[],
  standings: StandingRow[],
  teamStrength?: (name: string) => number,
): (T & { day: MatchDay })[] {
  const list = weekFixtures.slice();
  const result = new Map<T, MatchDay>();

  // Preserve any already-set day. Only fill in missing ones.
  const remaining: T[] = [];
  const filledCounts: Record<MatchDay, number> = { MON: 0, WED: 0, FRI: 0, SAT: 0 };
  for (const fx of list) {
    if (fx.day && MATCH_DAYS.includes(fx.day)) {
      result.set(fx, fx.day);
      filledCounts[fx.day]++;
    } else {
      remaining.push(fx);
    }
  }

  // If Friday still needs a fixture, pick marquee from remaining.
  if (filledCounts.FRI < DAY_QUOTA.FRI && remaining.length > 0) {
    const marquee = pickMarqueeFixture(remaining, standings, teamStrength);
    if (marquee) {
      result.set(marquee, "FRI");
      filledCounts.FRI++;
      const idx = remaining.indexOf(marquee);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  // Fill remaining days in order MON → WED → SAT.
  for (const day of ["MON", "WED", "SAT"] as MatchDay[]) {
    while (filledCounts[day] < DAY_QUOTA[day] && remaining.length > 0) {
      const fx = remaining.shift()!;
      result.set(fx, day);
      filledCounts[day]++;
    }
  }
  // Anything left over — shove into whichever day still has capacity, then
  // Saturday as a last resort so nothing ends up dayless.
  for (const fx of remaining) {
    const day = MATCH_DAYS.find((d) => filledCounts[d] < DAY_QUOTA[d]) ?? "SAT";
    result.set(fx, day);
    filledCounts[day]++;
  }

  return list.map((fx) => ({ ...fx, day: result.get(fx) ?? "SAT" }));
}

// Ensure every fixture across the whole league has a `day` set. Used by the
// state normalizer to migrate pre-daily-timeline saves.
export function backfillDays(
  fixtures: FixtureEntry[],
  standings: StandingRow[],
  teamStrength?: (name: string) => number,
): FixtureEntry[] {
  const byWeek = new Map<number, FixtureEntry[]>();
  for (const fx of fixtures) {
    if (!byWeek.has(fx.week)) byWeek.set(fx.week, []);
    byWeek.get(fx.week)!.push(fx);
  }
  const out: FixtureEntry[] = [];
  for (const [, list] of byWeek) {
    const assigned = assignDaysForWeek(list, standings, teamStrength);
    for (const fx of assigned) out.push(fx);
  }
  // Restore original ordering by id so external references remain stable.
  const byId = new Map(out.map((f) => [f.id, f] as const));
  return fixtures.map((f) => byId.get(f.id) ?? f);
}

// Transfer window helper — read at every mutator that moves player assets.
export function isTransferWindowOpen(state: LeagueState): boolean {
  const last = state.settings?.transferWindowLastWeek ?? 12;
  return state.currentWeek <= last;
}
