import { useMemo, useState } from "react";
import { reportAiOutcome } from "@/lib/ai-status";
import ReactMarkdown from "react-markdown";
import { useServerFn } from "@tanstack/react-start";
import { useLeague } from "@/state/league";
import { generateNews, type NewsKind } from "@/lib/news.functions";
import { buildPostgameBrief, buildRoundupBrief, buildDramaBrief } from "@/lib/news-brief";
import { downloadText } from "@/lib/league-export";
import { Button } from "@/components/ui/button";
import { PressConferenceDialog } from "@/components/PressConferenceDialog";
import { PressArchiveDialog } from "@/components/PressArchiveDialog";
import type { PressContext } from "@/lib/press-brief";

type Tab = NewsKind;

const TABS: { key: Tab; label: string; blurb: string }[] = [
  { key: "postgame", label: "Post-Game", blurb: "Match reports from a single completed fixture." },
  { key: "roundup", label: "Weekly Roundup", blurb: "League-wide wrap of a completed match week." },
  { key: "drama", label: "Media Drama", blurb: "Off-pitch storylines, title race & dressing-room mood." },
];

export function NewsSuite() {
  const { state, standings, leaderboards, clearPressArchive } = useLeague();
  const run = useServerFn(generateNews);

  const [tab, setTab] = useState<Tab>("postgame");
  const [fixtureId, setFixtureId] = useState<string>("");
  const [week, setWeek] = useState<number>(0);
  const [focus, setFocus] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [article, setArticle] = useState<string | null>(null);

  // Press conference dialog state.
  const [press, setPress] = useState<{ team: string; context: PressContext; fixtureId?: string } | null>(null);
  const [pressArticles, setPressArticles] = useState<{ id: string; team: string; context: PressContext; text: string; week: number }[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const exempt = state.settings?.contractExemptTeams ?? [];
  const userTeams = state.teamOrder.filter((t) => exempt.includes(t));

  // User-club fixtures for the current week that haven't been played yet → pre-match prompts.
  // Already-played user-club fixtures in the current week → post-match prompts.
  const pendingFixtures = useMemo(
    () => state.fixtures.filter(
      (f) => f.week === state.currentWeek && (userTeams.includes(f.home) || userTeams.includes(f.away)) && !state.results[f.id],
    ),
    [state.fixtures, state.currentWeek, userTeams, state.results],
  );
  const playedThisWeek = useMemo(
    () => state.fixtures.filter(
      (f) => f.week === state.currentWeek && (userTeams.includes(f.home) || userTeams.includes(f.away)) && state.results[f.id],
    ),
    [state.fixtures, state.currentWeek, userTeams, state.results],
  );

  // Completed fixtures (have both result + payload so individual events exist).
  const playedFixtures = useMemo(
    () =>
      state.fixtures
        .filter((f) => state.results[f.id] && state.payloads[f.id])
        .sort((a, b) => b.week - a.week),
    [state.fixtures, state.results, state.payloads]
  );

  // Weeks that have at least one recorded result.
  const playedWeeks = useMemo(() => {
    const ws = new Set<number>();
    for (const f of state.fixtures) if (state.results[f.id]) ws.add(f.week);
    return [...ws].sort((a, b) => b - a);
  }, [state.fixtures, state.results]);

  const generate = async () => {
    setError(null);
    setArticle(null);

    let brief: string | null = null;
    if (tab === "postgame") {
      const id = fixtureId || playedFixtures[0]?.id;
      if (!id) { setError("No completed match with recorded events yet."); return; }
      brief = buildPostgameBrief(state, id, standings);
    } else if (tab === "roundup") {
      const wk = week || playedWeeks[0];
      if (!wk) { setError("No completed match weeks yet."); return; }
      brief = buildRoundupBrief(state, standings, leaderboards, wk);
    } else {
      brief = buildDramaBrief(state, standings, leaderboards);
    }

    if (!brief) { setError("Not enough recorded data to write this story yet."); return; }

    setLoading(true);
    try {
      const res = await run({ data: { kind: tab, brief, focus: focus.trim() || undefined } });
      setArticle(res.article);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reportAiOutcome(msg);
      if (msg.includes("RATE_LIMIT")) setError("The AI desk is swamped — try again in a moment.");
      else if (msg.includes("CREDITS")) setError("AI credits exhausted. Add credits in Settings → Workspace → Usage.");
      else setError("Couldn't file the story. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const exportArticle = () => {
    if (!article) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadText(`eden-league-${tab}-${stamp}.md`, article);
  };



  return (
    <div className="space-y-4">
      <div className="rounded-lg border-l-4 border-highlight-blue bg-card px-4 py-2 text-xs text-muted-foreground">
        The Newsroom is purely for fun. Every article is written from your league's
        <span className="font-semibold text-foreground"> real results, ratings, and stats</span> — no invented numbers.
      </div>

      <section className="rounded-xl border border-stadium-gold/60 bg-card p-4 shadow">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-extrabold uppercase tracking-wide text-stadium-gold">Press Conferences</h2>
            <p className="text-[11px] text-muted-foreground">
              Face the press as one of your clubs' managers. Praise or criticism in your answers
              moves morale in real time and shifts your relationships with other managers.
              AI managers also hold a short press conference every week behind the scenes.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="font-semibold" onClick={() => setArchiveOpen(true)}>
              📚 View Press Conference Archives
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="font-semibold text-destructive hover:text-destructive"
              onClick={() => {
                const n = state.pressArchive?.length ?? 0;
                if (n === 0) return;
                if (!confirm(`Clear ALL ${n} press-conference entries from the archive? This cannot be undone and AI features will no longer be able to reference these quotes.`)) return;
                clearPressArchive();
              }}
            >
              🗑 Clear Archive
            </Button>
          </div>
        </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {userTeams.map((t) => (
              <Button key={t} size="sm" variant="outline" className="font-semibold"
                onClick={() => setPress({ team: t, context: "general" })}>
                🎤 {t} — General
              </Button>
            ))}
          </div>

          {pendingFixtures.length > 0 && (
            <div className="mt-3 rounded-lg border border-highlight-blue/40 bg-highlight-blue/5 p-2">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-highlight-blue">Pre-Match Press Available</div>
              <div className="flex flex-wrap gap-2">
                {pendingFixtures.map((f) => {
                  const myTeam = userTeams.includes(f.home) ? f.home : f.away;
                  const opp = myTeam === f.home ? f.away : f.home;
                  return (
                    <Button key={f.id} size="sm" variant="secondary" className="font-semibold"
                      onClick={() => setPress({ team: myTeam, context: "pre", fixtureId: f.id })}>
                      W{f.week} · {myTeam} vs {opp}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {playedThisWeek.length > 0 && (
            <div className="mt-3 rounded-lg border border-highlight-red/40 bg-highlight-red/5 p-2">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-highlight-red">Post-Match Press Available</div>
              <div className="flex flex-wrap gap-2">
                {playedThisWeek.map((f) => {
                  const myTeam = userTeams.includes(f.home) ? f.home : f.away;
                  const r = state.results[f.id];
                  return (
                    <Button key={f.id} size="sm" variant="secondary" className="font-semibold"
                      onClick={() => setPress({ team: myTeam, context: "post", fixtureId: f.id })}>
                      W{f.week} · {f.home} {r.homeGoals}-{r.awayGoals} {f.away}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {pressArticles.length > 0 && (
            <div className="mt-3 space-y-2">
              {pressArticles.slice(-3).reverse().map((pa) => (
                <div key={pa.id} className="rounded-lg border bg-background p-3">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    W{pa.week} · {pa.team} · {pa.context === "pre" ? "Pre-match" : pa.context === "post" ? "Post-match" : "General"}
                  </div>
                  <p className="text-xs leading-relaxed text-foreground whitespace-pre-wrap">{pa.text}</p>
                </div>
              ))}
            </div>
          )}

          {press && (
            <PressConferenceDialog
              open={!!press}
              team={press.team}
              context={press.context}
              fixtureId={press.fixtureId}
              onClose={() => setPress(null)}
              onRecap={(text) => setPressArticles((a) => [...a, {
                id: `${Date.now()}`, team: press.team, context: press.context, text, week: state.currentWeek,
              }])}
            />
          )}
        </section>

        <PressArchiveDialog open={archiveOpen} onClose={() => setArchiveOpen(false)} />



      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setArticle(null); setError(null); }}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              tab === t.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{TABS.find((t) => t.key === tab)?.blurb}</p>

      <div className="flex flex-wrap items-end gap-3">
        {tab === "postgame" && (
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
            MATCH
            <select
              value={fixtureId || playedFixtures[0]?.id || ""}
              onChange={(e) => setFixtureId(e.target.value)}
              className="rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
            >
              {playedFixtures.length === 0 && <option value="">No completed matches</option>}
              {playedFixtures.map((f) => {
                const r = state.results[f.id];
                return (
                  <option key={f.id} value={f.id}>
                    W{f.week}: {f.home} {r.homeGoals}–{r.awayGoals} {f.away}
                  </option>
                );
              })}
            </select>
          </label>
        )}

        {tab === "roundup" && (
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
            MATCH WEEK
            <select
              value={week || playedWeeks[0] || ""}
              onChange={(e) => setWeek(Number(e.target.value))}
              className="rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
            >
              {playedWeeks.length === 0 && <option value="">No completed weeks</option>}
              {playedWeeks.map((w) => (
                <option key={w} value={w}>Week {w}</option>
              ))}
            </select>
          </label>
        )}

        <Button onClick={generate} disabled={loading} className="font-semibold">
          {loading ? "Filing story…" : "✍ Write Article"}
        </Button>
      </div>

      <label className="flex flex-col gap-1 text-xs font-semibold uppercase text-muted-foreground">
        STORY ANGLE <span className="font-normal normal-case">(optional — ask the analyst anything: tactics, injuries, schedule difficulty, matchups)</span>
        <textarea
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder={
            'e.g. "How are [team]\u2019s tactics affecting their results \u2014 is it working, or should [manager] switch?" \u00b7 ' +
            '"[team] are missing [injured player] this week \u2014 how will that change their lineup and tactics?" \u00b7 ' +
            '"Analyse [team]\u2019s remaining schedule \u2014 is it harder or easier than their rivals\u2019?"'
          }
          className="resize-y rounded-md border bg-background px-3 py-2 text-sm font-normal text-foreground placeholder:text-muted-foreground"
        />
      </label>

      {error && (
        <div className="rounded-lg border-l-4 border-highlight-red bg-card px-4 py-3 text-sm text-foreground">
          {error}
        </div>
      )}

      {loading && !article && (
        <div className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          The beat writer is at the keyboard…
        </div>
      )}

      {article && (
        <article className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-4 flex justify-end">
            <Button size="sm" variant="outline" onClick={exportArticle} className="font-semibold">
              ⬇ Export Article
            </Button>
          </div>
          <div className="space-y-3 text-foreground/90">
            <ReactMarkdown
              components={{
                h2: ({ children }) => (
                  <h2 className="text-xl font-extrabold tracking-tight text-foreground">{children}</h2>
                ),
                h1: ({ children }) => (
                  <h2 className="text-xl font-extrabold tracking-tight text-foreground">{children}</h2>
                ),
                p: ({ children }) => <p className="leading-relaxed">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                em: ({ children }) => <em className="italic">{children}</em>,
              }}
            >
              {article}
            </ReactMarkdown>
          </div>
          <div className="mt-4 border-t pt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
            Eden League Newsroom · AI-written from real league data · entertainment only
          </div>
        </article>
      )}
    </div>
  );
}
