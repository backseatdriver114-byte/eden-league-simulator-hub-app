import { useState } from "react";
import { useLeague } from "@/state/league";
import { TeamBadge } from "@/components/TeamBadge";
import { lastFive, currentStreak, formPillClass, gdColorStyle } from "@/lib/team-stats";
import { getTeamColors } from "@/lib/team-branding";

const COLS: { key: string; label: string }[] = [
  { key: "rank", label: "RANK" },
  { key: "team", label: "TEAM NAME" },
  { key: "form", label: "FORM" },
  { key: "streak", label: "STREAK" },
  { key: "pld", label: "PLD" },
  { key: "w", label: "W" },
  { key: "d", label: "D" },
  { key: "l", label: "L" },
  { key: "gf", label: "GF" },
  { key: "ga", label: "GA" },
  { key: "gd", label: "GD" },
  { key: "pts", label: "PTS" },
];

type View = "standings" | "scorers" | "assists" | "keepers";

const TABS: { key: View; label: string }[] = [
  { key: "standings", label: "Standings" },
  { key: "scorers", label: "Golden Boot" },
  { key: "assists", label: "Assists" },
  { key: "keepers", label: "Golden Glove" },
];

export function StandingsSuite() {
  const [view, setView] = useState<View>("standings");

  return (
    <div className="space-y-4">
      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              view === t.key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === "standings" ? <StandingsTable /> : <Leaderboard view={view} />}
    </div>
  );
}

function StandingsTable() {
  const { state, standings } = useLeague();
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b bg-panel text-left text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {COLS.map((c) => (
              <th key={c.key} className={`px-3 py-2.5 ${c.key === "team" ? "text-left" : "text-center"}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {standings.map((row) => {
            const colors = getTeamColors(state.teams[row.team] ?? { name: row.team });
            const primary = colors.primary ?? "hsl(var(--border))";
            const form = lastFive(state, row.team);
            const streak = currentStreak(state, row.team);
            return (
              <tr
                key={row.team}
                className="border-b last:border-0 transition-colors hover:bg-muted/50"
                style={{
                  borderLeft: `4px solid ${primary}`,
                  backgroundColor: `color-mix(in oklab, ${primary} 8%, transparent)`,
                }}
              >
                <td className="px-3 py-2 text-center font-mono font-semibold tabular-nums">{row.rank}</td>
                <td className="px-3 py-2 font-medium"><TeamBadge team={row.team} showName /></td>
                <td className="px-3 py-2">
                  <div className="flex justify-center gap-0.5">
                    {form.length === 0 ? <span className="text-[10px] text-muted-foreground">—</span> :
                      form.map((r, i) => (
                        <span
                          key={i}
                          className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${formPillClass(r)}`}
                        >{r}</span>
                      ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-center">
                  {streak ? (
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 font-mono text-[11px] font-bold ${
                        streak.kind === "W"
                          ? "bg-success/20 text-success"
                          : streak.kind === "L"
                          ? "bg-destructive/20 text-destructive"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >{streak.kind}{streak.count}</span>
                  ) : <span className="text-[10px] text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2 text-center tabular-nums">{row.pld}</td>
                <td className="px-3 py-2 text-center tabular-nums">{row.w}</td>
                <td className="px-3 py-2 text-center tabular-nums">{row.d}</td>
                <td className="px-3 py-2 text-center tabular-nums">{row.l}</td>
                <td className="px-3 py-2 text-center tabular-nums">{row.gf}</td>
                <td className="px-3 py-2 text-center tabular-nums">{row.ga}</td>
                <td className="px-3 py-2 text-center font-bold tabular-nums" style={gdColorStyle(row.gd)}>
                  {row.gd > 0 ? `+${row.gd}` : row.gd}
                </td>
                <td className="px-3 py-2 text-center font-mono font-bold tabular-nums text-primary">{row.pts}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Leaderboard({ view }: { view: Exclude<View, "standings"> }) {
  const { leaderboards } = useLeague();

  const config = {
    scorers: {
      title: "Top Goal Scorers — The Golden Boot",
      rows: leaderboards.scorers,
      cols: ["Player", "Club", "Goals", "Assists"],
      cells: (r: (typeof leaderboards.scorers)[number]) => [r.name, <TeamBadge key="b" team={r.team} showName />, r.goals, r.assists],
      empty: "No goals recorded yet. Simulate matches to populate the Golden Boot race.",
    },
    assists: {
      title: "Assist Leaders",
      rows: leaderboards.assists,
      cols: ["Player", "Club", "Assists", "Goals"],
      cells: (r: (typeof leaderboards.assists)[number]) => [r.name, <TeamBadge key="b" team={r.team} showName />, r.assists, r.goals],
      empty: "No assists recorded yet. Simulate matches to populate the assist chart.",
    },
    keepers: {
      title: "Top Goalkeepers — The Golden Glove",
      rows: leaderboards.keepers,
      cols: ["Keeper", "Club", "Clean Sheets", "Conceded", "Apps"],
      cells: (r: (typeof leaderboards.keepers)[number]) => [r.name, <TeamBadge key="b" team={r.team} showName />, r.cleanSheets, r.conceded, r.apps],
      empty: "No goalkeeper data yet. Simulate matches to populate the Golden Glove race.",
    },
  }[view];

  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <div className="border-b px-4 py-2.5 text-sm font-bold uppercase tracking-wide">
        {config.title}
      </div>
      {config.rows.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">{config.empty}</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-panel text-left text-xs font-bold uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2.5 text-center">#</th>
              {config.cols.map((c, i) => (
                <th key={c} className={`px-3 py-2.5 ${i < 2 ? "text-left" : "text-center"}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {config.rows.map((r, idx) => {
              const cells = config.cells(r as never);
              return (
                <tr key={`${r.team}-${r.name}`} className="border-b last:border-0 odd:bg-muted/40">
                  <td className="px-3 py-2 text-center font-mono font-semibold tabular-nums">{idx + 1}</td>
                  {cells.map((c, i) => (
                    <td
                      key={i}
                      className={`px-3 py-2 ${i < 2 ? "font-medium" : "text-center font-mono tabular-nums"} ${
                        i === 2 ? "font-bold text-primary" : ""
                      }`}
                    >
                      {c}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
