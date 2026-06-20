import { useState } from "react";
import { useLeague } from "@/state/league";

const COLS: { key: string; label: string }[] = [
  { key: "rank", label: "RANK" },
  { key: "team", label: "TEAM NAME" },
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
  const { standings } = useLeague();
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
          {standings.map((row) => (
            <tr key={row.team} className="border-b last:border-0 odd:bg-muted/40">
              <td className="px-3 py-2 text-center font-mono font-semibold tabular-nums">{row.rank}</td>
              <td className="px-3 py-2 font-medium">{row.team}</td>
              <td className="px-3 py-2 text-center tabular-nums">{row.pld}</td>
              <td className="px-3 py-2 text-center tabular-nums">{row.w}</td>
              <td className="px-3 py-2 text-center tabular-nums">{row.d}</td>
              <td className="px-3 py-2 text-center tabular-nums">{row.l}</td>
              <td className="px-3 py-2 text-center tabular-nums">{row.gf}</td>
              <td className="px-3 py-2 text-center tabular-nums">{row.ga}</td>
              <td className="px-3 py-2 text-center tabular-nums">
                {row.gd > 0 ? `+${row.gd}` : row.gd}
              </td>
              <td className="px-3 py-2 text-center font-mono font-bold tabular-nums text-primary">{row.pts}</td>
            </tr>
          ))}
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
      cells: (r: (typeof leaderboards.scorers)[number]) => [r.name, r.team, r.goals, r.assists],
      empty: "No goals recorded yet. Simulate matches to populate the Golden Boot race.",
    },
    assists: {
      title: "Assist Leaders",
      rows: leaderboards.assists,
      cols: ["Player", "Club", "Assists", "Goals"],
      cells: (r: (typeof leaderboards.assists)[number]) => [r.name, r.team, r.assists, r.goals],
      empty: "No assists recorded yet. Simulate matches to populate the assist chart.",
    },
    keepers: {
      title: "Top Goalkeepers — The Golden Glove",
      rows: leaderboards.keepers,
      cols: ["Keeper", "Club", "Clean Sheets", "Conceded", "Apps"],
      cells: (r: (typeof leaderboards.keepers)[number]) => [r.name, r.team, r.cleanSheets, r.conceded, r.apps],
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
