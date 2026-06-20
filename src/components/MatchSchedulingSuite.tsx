import { useLeague, isWeekComplete } from "@/state/league";
import { FixtureBuilder } from "@/components/FixtureBuilder";

const FINAL_FOUR_WEEKS = [13, 14, 15, 16];
const REGULAR_WEEKS = Array.from({ length: 12 }, (_, i) => i + 1);

export function MatchSchedulingSuite() {
  const { state, scheduleFinalFour, scheduleNewSeason } = useLeague();

  const week12Done = isWeekComplete(state, 12);
  const finalFourExists = state.fixtures.some((f) => f.week >= 13);
  const seasonOver = !!state.playoffs?.champion;

  // Phase 1: Final Four scheduling (after Week 12, before Final Four exists).
  if (week12Done && !finalFourExists) {
    return (
      <div className="space-y-4">
        <Banner
          title={`Schedule the Final Four · Season ${state.season}`}
          body="Week 12 is complete. The Final Four spans FOUR full weeks (Weeks 13–16) — schedule all 48 fixtures (12 matches per week, every team plays once a week). Pick the two clubs for each match, add them week by week, then save to append these weeks to the Season Schedule."
        />
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <FixtureBuilder
            weeks={FINAL_FOUR_WEEKS}
            title="Final Four Builder (Weeks 13–16 · 12 matches each)"
            commit={scheduleFinalFour}
            saveLabelOverride="SAVE FINAL FOUR"
            phase="finalfour"
          />
          <StandingsReference />
        </div>
      </div>
    );
  }

  // Phase 2: New-season scheduling (after the Eden League Final crowns a champion).
  if (seasonOver) {
    return (
      <div className="space-y-4">
        <Banner
          title={`Schedule Season ${state.season + 1}`}
          body="The Eden League Final is finished. Make any promotion/relegation and draft changes in the Team Editor FIRST, then enter the 12-week schedule below. Saving carries over all rosters and budgets, clears the previous season's results, and kicks off the new season — no other action is required."
        />
        <FixtureBuilder
          weeks={REGULAR_WEEKS}
          title="New Season Builder (Weeks 1–12)"
          commit={scheduleNewSeason}
          saveLabelOverride="START SEASON WITH THESE FIXTURES"
          phase="regular"
        />
      </div>
    );
  }

  // Otherwise: nothing to schedule right now.
  return (
    <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
      <p className="mb-2 font-semibold text-foreground">No scheduling actions required</p>
      <p>
        The Match Scheduling suite unlocks when Week 12 concludes (to build the Final Four) or when
        the Eden League Final crowns a champion (to schedule the next season).
      </p>
    </div>
  );
}

function StandingsReference() {
  const { standings } = useLeague();
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <div className="border-b px-4 py-2.5 text-sm font-bold uppercase tracking-wide">
        Standings Reference
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b bg-panel text-left font-bold uppercase text-muted-foreground">
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Team</th>
            <th className="px-3 py-2 text-center">PTS</th>
            <th className="px-3 py-2 text-center">GD</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((row) => (
            <tr key={row.team} className="border-b last:border-0 odd:bg-muted/40">
              <td className="px-3 py-1.5 text-center font-mono tabular-nums">{row.rank}</td>
              <td className="px-3 py-1.5 font-medium">{row.team}</td>
              <td className="px-3 py-1.5 text-center font-mono font-bold tabular-nums text-primary">{row.pts}</td>
              <td className="px-3 py-1.5 text-center tabular-nums">{row.gd > 0 ? `+${row.gd}` : row.gd}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Banner({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border bg-panel/50 p-4 text-sm">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-muted-foreground">{body}</p>
    </div>
  );
}
