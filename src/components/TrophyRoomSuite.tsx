// Trophy Room / League History suite.
// Reads the cloud-persisted `league_history` table (written after each playoff
// champion is crowned) and shows:
//   - a season champions timeline
//   - award winners per season (Golden Boot / Glove / MVP)
//   - per-club trophy case (all-time titles + years)
// Also derives an "in-progress" record for the current season from live state.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useLeague } from "@/state/league";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeamColors } from "@/lib/team-branding";

interface HistoryRow {
  season: number;
  champion: string | null;
  standings: unknown;
  leaderboards: unknown;
}

interface Leader { team: string; name: string; goals?: number; assists?: number; cleanSheets?: number; conceded?: number }

interface HistorySeason {
  season: number;
  champion: string | null;
  runnerUp?: string;
  goldenBoot?: Leader;
  goldenGlove?: Leader;
  mvp?: Leader;
}

function toSeason(row: HistoryRow): HistorySeason {
  const standings = Array.isArray(row.standings) ? row.standings as { team: string }[] : [];
  const lb = row.leaderboards as { scorers?: Leader[]; assists?: Leader[]; keepers?: Leader[] } | null;
  const scorers = lb?.scorers ?? [];
  const keepers = lb?.keepers ?? [];
  const goldenBoot = scorers[0];
  const goldenGlove = keepers[0];
  // MVP heuristic: top scorer + top assister composite; fall back to scorer.
  const mvp = scorers[0]
    ? { team: scorers[0].team, name: scorers[0].name, goals: scorers[0].goals, assists: scorers[0].assists }
    : undefined;
  return {
    season: row.season,
    champion: row.champion,
    runnerUp: standings[1]?.team,
    goldenBoot,
    goldenGlove,
    mvp,
  };
}

export function TrophyRoomSuite() {
  const { state, standings, leaderboards } = useLeague();
  const [rows, setRows] = useState<HistorySeason[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("league_history")
          .select("season, champion, standings, leaderboards")
          .order("season", { ascending: false });
        if (cancelled) return;
        if (error) throw error;
        setRows((data ?? []).map((r) => toSeason(r as HistoryRow)));
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Current-season snapshot (in-progress) — always shown at the top.
  const inProgress = useMemo<HistorySeason>(() => ({
    season: state.season,
    champion: state.playoffs?.champion ?? null,
    runnerUp: standings[1]?.team,
    goldenBoot: leaderboards.scorers[0],
    goldenGlove: leaderboards.keepers[0],
    mvp: leaderboards.scorers[0] ? {
      team: leaderboards.scorers[0].team,
      name: leaderboards.scorers[0].name,
      goals: leaderboards.scorers[0].goals,
      assists: leaderboards.scorers[0].assists,
    } : undefined,
  }), [state.season, state.playoffs?.champion, standings, leaderboards]);

  // Per-club title tally across archived seasons.
  const trophyCase = useMemo(() => {
    const map = new Map<string, number[]>(); // team -> [season, season, ...]
    for (const r of rows) if (r.champion) {
      const arr = map.get(r.champion) ?? [];
      arr.push(r.season);
      map.set(r.champion, arr);
    }
    return state.teamOrder.map((t) => ({ team: t, seasons: map.get(t) ?? [] }))
      .sort((a, b) => b.seasons.length - a.seasons.length || a.team.localeCompare(b.team));
  }, [rows, state.teamOrder]);

  return (
    <div className="space-y-6">
      {/* Champions timeline */}
      <section className="rounded-xl border bg-card">
        <div className="border-b bg-panel px-4 py-2.5 text-sm font-bold uppercase tracking-wide">
          Champions Timeline
        </div>
        {loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading history…</div>
        ) : (
          <ol className="divide-y">
            <SeasonRow s={inProgress} inProgress />
            {rows.map((r) => <SeasonRow key={r.season} s={r} />)}
            {rows.length === 0 && (
              <li className="p-4 text-center text-xs text-muted-foreground">
                No completed seasons yet. Once a playoffs champion is crowned, the season is archived here.
              </li>
            )}
          </ol>
        )}
        {err && <div className="px-4 py-2 text-xs text-destructive">{err}</div>}
      </section>

      {/* Awards per season */}
      <section className="rounded-xl border bg-card">
        <div className="border-b bg-panel px-4 py-2.5 text-sm font-bold uppercase tracking-wide">
          Season Awards
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b bg-panel/50 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left">Season</th>
                <th className="px-3 py-2 text-left">Golden Boot</th>
                <th className="px-3 py-2 text-left">Golden Glove</th>
                <th className="px-3 py-2 text-left">MVP</th>
              </tr>
            </thead>
            <tbody>
              <AwardRow s={inProgress} inProgress />
              {rows.map((r) => <AwardRow key={r.season} s={r} />)}
            </tbody>
          </table>
        </div>
      </section>

      {/* Per-club trophy case */}
      <section className="rounded-xl border bg-card">
        <div className="border-b bg-panel px-4 py-2.5 text-sm font-bold uppercase tracking-wide">
          Trophy Case (all-time)
        </div>
        <ul className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
          {trophyCase.map(({ team, seasons }) => {
            const colors = getTeamColors({ name: team });
            const primary = colors.primary ?? "hsl(var(--border))";
            return (
              <li
                key={team}
                className="flex items-center gap-2 rounded-md border bg-background px-3 py-2"
                style={{ borderLeft: `4px solid ${primary}` }}
              >
                <TeamBadge team={team} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{team}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {seasons.length === 0
                      ? "No titles yet"
                      : `${seasons.length} title${seasons.length > 1 ? "s" : ""} · ${seasons.slice(0, 6).map((s) => `S${s}`).join(", ")}${seasons.length > 6 ? "…" : ""}`}
                  </div>
                </div>
                <div className="text-lg font-extrabold text-primary">🏆 {seasons.length}</div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function SeasonRow({ s, inProgress }: { s: HistorySeason; inProgress?: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="w-16 font-mono text-sm font-bold text-muted-foreground">S{s.season}</div>
      <div className="flex items-center gap-2">
        {s.champion ? (
          <>
            <TeamBadge team={s.champion} size={32} />
            <span className="font-bold">{s.champion}</span>
            <span className="rounded bg-accent px-2 py-0.5 text-[10px] font-bold uppercase text-accent-foreground">
              {inProgress ? "In progress" : "Champion"}
            </span>
          </>
        ) : (
          <span className="text-xs italic text-muted-foreground">Playoffs not yet complete</span>
        )}
      </div>
      {s.runnerUp && (
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span>Runner-up:</span>
          <TeamBadge team={s.runnerUp} size={20} showName />
        </div>
      )}
    </li>
  );
}

function AwardRow({ s, inProgress }: { s: HistorySeason; inProgress?: boolean }) {
  return (
    <tr className="border-b last:border-0 odd:bg-muted/30">
      <td className="px-3 py-2 font-mono font-bold">
        S{s.season}{inProgress && <span className="ml-1 text-[10px] font-normal text-muted-foreground">(live)</span>}
      </td>
      <td className="px-3 py-2">
        {s.goldenBoot ? (
          <span className="flex items-center gap-1.5">
            <TeamBadge team={s.goldenBoot.team} size={18} />
            <span className="font-medium">{s.goldenBoot.name}</span>
            <span className="text-xs text-muted-foreground">· {s.goldenBoot.goals} G</span>
          </span>
        ) : <span className="text-xs text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2">
        {s.goldenGlove ? (
          <span className="flex items-center gap-1.5">
            <TeamBadge team={s.goldenGlove.team} size={18} />
            <span className="font-medium">{s.goldenGlove.name}</span>
            <span className="text-xs text-muted-foreground">· {s.goldenGlove.cleanSheets ?? 0} CS</span>
          </span>
        ) : <span className="text-xs text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2">
        {s.mvp ? (
          <span className="flex items-center gap-1.5">
            <TeamBadge team={s.mvp.team} size={18} />
            <span className="font-medium">{s.mvp.name}</span>
          </span>
        ) : <span className="text-xs text-muted-foreground">—</span>}
      </td>
    </tr>
  );
}
