// League history archive — quiet background record of completed seasons used
// to ground the AI match-scheduling engine. No UI; the data flows automatically.
import { supabase } from "@/integrations/supabase/client";
import type { LeagueState } from "@/state/league";
import { computeStandings, computeLeaderboards } from "@/state/league";

export interface LeagueHistoryRow {
  season: number;
  champion: string | null;
  summary: string;
  standings: unknown;
  leaderboards: unknown;
  data: unknown;
}

// Build a compact, plain-text summary of a completed season — the format the
// schedule-brief feeds into the AI fixture generator. Mentions champion,
// top 8 teams, top 3 scorers, and any user-club final position so the AI can
// favor rivalries / dramatic matchups.
export function buildSeasonSummary(state: LeagueState): string {
  const standings = computeStandings(state);
  const leaderboards = computeLeaderboards(state);
  const champion = state.playoffs?.champion ?? null;
  const topTable = standings.slice(0, 8)
    .map((r) => `  ${r.rank}. ${r.team} — ${r.pts} pts (${r.w}-${r.d}-${r.l}, GD ${r.gd >= 0 ? "+" : ""}${r.gd})`)
    .join("\n");
  const topScorers = leaderboards.scorers.slice(0, 3)
    .map((r, i) => `  ${i + 1}. ${r.name} (${r.team}) — ${r.goals} goals`)
    .join("\n");
  return [
    `Season ${state.season} — Champion: ${champion ?? "unknown"}.`,
    `Final regular-season top 8:`,
    topTable || "  (no data)",
    `Top scorers:`,
    topScorers || "  (no data)",
  ].join("\n");
}

// Persist a snapshot of the just-completed season. Idempotent on `season`
// thanks to the unique constraint — repeated calls upsert.
export async function recordCompletedSeason(state: LeagueState): Promise<void> {
  if (typeof window === "undefined") return;
  const standings = computeStandings(state);
  const leaderboards = computeLeaderboards(state);
  const champion = state.playoffs?.champion ?? null;
  const summary = buildSeasonSummary(state);
  try {
    await supabase
      .from("league_history")
      .upsert(
        {
          season: state.season,
          champion,
          summary,
          standings: standings as unknown as Record<string, unknown>[],
          leaderboards: leaderboards as unknown as Record<string, unknown>,
          data: {} as Record<string, unknown>,
        } as never,
        { onConflict: "season" } as never,
      );
  } catch (e) {
    // Background archive — never block the UI on a failure.
    console.warn("[league-history] archive write failed", e);
  }
}

// Fetch the most recent `count` archived season summaries (newest first),
// joined into a single block of text suitable for an AI brief.
export async function fetchRecentSeasonSummaries(count = 3): Promise<string> {
  if (typeof window === "undefined") return "";
  try {
    const { data, error } = await supabase
      .from("league_history")
      .select("season, summary")
      .order("season", { ascending: false })
      .limit(count);
    if (error || !data || data.length === 0) return "";
    return (data as { season: number; summary: string }[])
      .map((r) => r.summary)
      .join("\n\n");
  } catch {
    return "";
  }
}
