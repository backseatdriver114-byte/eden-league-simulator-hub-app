// News auto-generation watcher. Observes league state changes and, based on
// the `settings.newsFrequency` slider (0..1), rolls to auto-file short news
// articles for notable events: match results (upsets, big wins, comebacks),
// win/unbeaten streaks, standings leader shifts, trade completions, and
// manager sackings. Uses the existing generateNews server fn + brief builders.
//
// This is a pure watcher (no DOM), mounted once by the Hub. All AI calls are
// best-effort; failures are swallowed silently so a flaky provider never
// derails simulation. Frequency 0 disables everything; 1 = every event.

import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useLeague } from "@/state/league";
import { generateNews } from "@/lib/news.functions";
import { buildPostgameBrief, buildDramaBrief } from "@/lib/news-brief";
import { currentStreak } from "@/lib/team-stats";

// Minimum ms between two auto-gen dispatches to avoid burst-firing.
const MIN_GAP_MS = 4000;

export function NewsAutogenWatcher() {
  const { state, standings, appendArticleEntry } = useLeague();
  const run = useServerFn(generateNews);

  const seenResults = useRef<Set<string>>(new Set());
  const seenEvents = useRef<Set<string>>(new Set());
  const streakSnap = useRef<Map<string, string>>(new Map()); // team -> "W3"
  const lastLeader = useRef<string | null>(null);
  const lastDispatch = useRef<number>(0);
  const primed = useRef(false);

  const freq = state.settings?.newsFrequency ?? 0.5;

  useEffect(() => {
    // Seed refs on first mount so we don't retroactively write articles for
    // every historical result / event already in the save.
    if (!primed.current) {
      for (const id of Object.keys(state.results)) seenResults.current.add(id);
      for (const e of state.leagueEvents ?? []) seenEvents.current.add(e.id);
      for (const t of state.teamOrder) {
        const s = currentStreak(state, t);
        if (s) streakSnap.current.set(t, `${s.kind}${s.count}`);
      }
      lastLeader.current = standings[0]?.team ?? null;
      primed.current = true;
      return;
    }

    if (freq <= 0) return;

    const now = Date.now();
    const canFire = () => (Date.now() - lastDispatch.current) >= MIN_GAP_MS;

    const roll = (weight = 1) => Math.random() < Math.min(1, freq * weight);

    async function fireArticle(kind: "postgame" | "drama", brief: string, title: string, week: number, focus?: string) {
      if (!canFire()) return;
      lastDispatch.current = Date.now();
      try {
        const { article } = await run({ data: { kind, brief, focus } });
        // Extract H2 as title if present.
        const m = article.match(/^##\s+(.+)$/m);
        appendArticleEntry({
          season: state.season,
          week,
          kind,
          title: m?.[1]?.trim().slice(0, 140) ?? title.slice(0, 140),
          body: article,
          focus,
        });
      } catch { /* swallow — best-effort */ }
    }

    // 1) New match results
    for (const fx of state.fixtures) {
      const r = state.results[fx.id];
      if (!r) continue;
      if (seenResults.current.has(fx.id)) continue;
      seenResults.current.add(fx.id);
      // Only postgame-worthy if payload exists (SIM matches carry rich data).
      if (!state.payloads[fx.id]) continue;
      const margin = Math.abs(r.homeGoals - r.awayGoals);
      const homeRank = standings.find((s) => s.team === fx.home)?.rank ?? 12;
      const awayRank = standings.find((s) => s.team === fx.away)?.rank ?? 12;
      const winnerIsUnderdog =
        (r.homeGoals > r.awayGoals && homeRank > awayRank + 6) ||
        (r.awayGoals > r.homeGoals && awayRank > homeRank + 6);
      const bigWin = margin >= 4;
      const notable = winnerIsUnderdog || bigWin;
      // Roll: upsets/blowouts fire at 1.5x weight, regular results at 0.4x.
      if (!roll(notable ? 1.5 : 0.4)) continue;
      const brief = buildPostgameBrief(state, fx.id, standings);
      if (!brief) continue;
      const focus = winnerIsUnderdog
        ? "Frame this as a genuine upset — the underdog stunned a higher-ranked side."
        : bigWin
        ? "Frame this as a statement blowout — dissect how the winner ran riot."
        : undefined;
      void fireArticle("postgame", brief, `${fx.home} vs ${fx.away}`, fx.week, focus);
      break; // one match report per state tick
    }

    // 2) Streak articles (win streak >= 3 OR unbeaten >= 5)
    for (const t of state.teamOrder) {
      const s = currentStreak(state, t);
      const key = s ? `${s.kind}${s.count}` : "";
      const prev = streakSnap.current.get(t) ?? "";
      if (key !== prev) {
        streakSnap.current.set(t, key);
        if (s && ((s.kind === "W" && s.count >= 3) || (s.kind !== "L" && s.count >= 5))) {
          if (roll(0.7)) {
            const focus = `${t} are on a ${s.count}-match ${s.kind === "W" ? "winning" : "unbeaten"} run. Lead the article on that streak.`;
            const brief = buildDramaBrief(state, standings, { scorers: [], assists: [], keepers: [] } as unknown as Parameters<typeof buildDramaBrief>[2]);
            void fireArticle("drama", brief, `${t} streak`, state.currentWeek, focus);
            break;
          }
        }
      }
    }

    // 3) Standings leader change
    const leader = standings[0]?.team ?? null;
    if (leader && leader !== lastLeader.current) {
      const prev = lastLeader.current;
      lastLeader.current = leader;
      if (prev && roll(1.2)) {
        const focus = `${leader} have overtaken ${prev} at the top of the table. Lead the article on the new leader.`;
        const brief = buildDramaBrief(state, standings, { scorers: [], assists: [], keepers: [] } as unknown as Parameters<typeof buildDramaBrief>[2]);
        void fireArticle("drama", brief, `${leader} take the top`, state.currentWeek, focus);
      }
    }

    // 4) New league events (trades / manager fires)
    for (const evt of state.leagueEvents ?? []) {
      if (seenEvents.current.has(evt.id)) continue;
      seenEvents.current.add(evt.id);
      // Always emit for these — small in number.
      if (!roll(1.5)) continue;
      const focus = `Breaking league news: ${evt.detail}. Lead the article on this event and its likely ripple effects.`;
      const brief = buildDramaBrief(state, standings, { scorers: [], assists: [], keepers: [] } as unknown as Parameters<typeof buildDramaBrief>[2]);
      void fireArticle("drama", brief, evt.detail.slice(0, 60), evt.week, focus);
      break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.results, state.leagueEvents, state.fixtures.length, freq]);

  return null;
}
