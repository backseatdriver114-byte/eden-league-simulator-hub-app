import { useEffect, useRef, useState } from "react";
import { reportAiOutcome } from "@/lib/ai-status";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useLeague } from "@/state/league";
import { buildPressBrief, type PressContext } from "@/lib/press-brief";
import {
  generateNextPressQuestion, scorePressAnswer, writePressRecap, type PressTarget,
} from "@/lib/press-conference.functions";
import { logPressTargets } from "@/lib/press-log";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  team: string;
  context: PressContext;
  fixtureId?: string;
  onClose: () => void;
  // Called after recap is written so the parent can pin it into the feed.
  onRecap?: (article: string) => void;
}

interface Exchange { question: string; answer: string; }

// Compute the live influence multiplier from settings + speaker respect.
function influenceMult(respect: number, baseline: number): number {
  const respectScale = Math.max(0.4, Math.min(1.6, respect / 50));
  return baseline * respectScale;
}

export function PressConferenceDialog({ open, team, context, fixtureId, onClose, onRecap }: Props) {
  const {
    state, standings, leaderboards,
    applyPlayerMoraleDelta, applyTeamMoraleDelta, applyRelationDelta,
    applyManagerRespectDelta, applyManagerHarshnessSample, appendPressEntry,
  } = useLeague();
  const askNext = useServerFn(generateNextPressQuestion);
  const scoreA = useServerFn(scorePressAnswer);
  const recapFn = useServerFn(writePressRecap);

  const TOTAL_QUESTIONS = 4;
  const [currentQuestion, setCurrentQuestion] = useState<string | null>(null);
  const [idx, setIdx] = useState(0); // 0-indexed position of current question
  const [answer, setAnswer] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const startedRef = useRef<string | null>(null);

  const managerName = state.managers?.[team]?.name ?? "Manager";
  const respect = state.managers?.[team]?.respect ?? 50;
  const baseInfluence = state.settings?.pressInfluenceBaseline ?? 1;
  const mult = influenceMult(respect, baseInfluence);

  // Fetch a single question (the opening one when called on open, or the
  // next follow-up after each answered exchange).
  async function fetchQuestion(priorExchanges: Exchange[]) {
    const brief = buildPressBrief({ state, standings, leaderboards, team, context, fixtureId });
    if (!brief) { setError("Couldn't build a press brief for this team."); return; }
    setLoading(true);
    try {
      const r = await askNext({
        data: {
          team, managerName, context, brief,
          priorExchanges,
          questionNumber: priorExchanges.length + 1,
          totalQuestions: TOTAL_QUESTIONS,
        },
      });
      setCurrentQuestion(r.question);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setLoading(false);
    }
  }

  // Load first question on open.
  useEffect(() => {
    if (!open) return;
    const key = `${team}::${context}::${fixtureId ?? ""}::${state.currentWeek}`;
    if (startedRef.current === key) return;
    startedRef.current = key;
    setCurrentQuestion(null); setIdx(0); setAnswer(""); setExchanges([]); setError(null);
    void fetchQuestion([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, team, context, fixtureId]);

  function applyTargets(targets: PressTarget[]) {
    for (const t of targets) {
      if (t.kind === "team") {
        const sameTeam = t.name === team ? 1.5 : 1.0;
        applyTeamMoraleDelta(t.name, Math.round(t.moraleDelta * mult * sameTeam));
      } else if (t.kind === "player") {
        if (t.team === team) {
          // Manager talking about own player — full influence (+ slight boost).
          applyPlayerMoraleDelta(t.team, t.name, Math.round(t.moraleDelta * mult * 1.5));
        } else {
          // Outside-the-club chatter is capped: top pros barely care what some
          // other manager says on TV, and a low-respect manager carries less
          // weight than a beloved one.
          const player = state.teams[t.team]?.players.find((p) => p.name === t.name);
          const rating = player?.rating ?? 6;
          const ratingCap = Math.max(0, 1 - Math.max(0, rating - 6) / 4); // 0 at rating ≥10
          const speakerRespect = state.managers?.[team]?.respect ?? 50;
          const respectMul = Math.max(0.2, Math.min(1.5, speakerRespect / 50));
          const externalCap = ratingCap * respectMul;
          applyPlayerMoraleDelta(t.team, t.name, Math.round(t.moraleDelta * mult * externalCap));
        }
      } else if (t.kind === "manager") {
        // Relations are USER↔AI only; ignore if target manager isn't an AI club.
        const mgr = state.managers?.[t.team];
        if (!mgr) continue;
        if ((mgr.personality ?? "").trim().toUpperCase() === "USER CONTROLLED") continue;
        applyRelationDelta(t.team, t.relationDelta * mult);
      }
    }
  }

  async function submit() {
    if (!currentQuestion) return;
    const a = answer.trim();
    if (!a || loading) return;
    setError(null);
    setLoading(true);
    const q = currentQuestion;
    try {
      const brief = buildPressBrief({ state, standings, leaderboards, team, context, fixtureId }) ?? "";
      const validTeams = state.teamOrder;
      const validManagers = state.teamOrder
        .map((tm) => ({ team: tm, name: state.managers?.[tm]?.name ?? tm }))
        .filter((m) => m.name && m.name.toUpperCase() !== "USER CONTROLLED");
      const validPlayers: { team: string; name: string }[] = [];
      for (const tm of state.teamOrder) {
        for (const p of state.teams[tm]?.players ?? []) validPlayers.push({ team: tm, name: p.name });
      }
      const res = await scoreA({
        data: {
          team, managerName, context, brief,
          question: q, answer: a, validTeams, validManagers, validPlayers,
        },
      });
      applyTargets(res.targets);
      const exemptTeams = state.settings?.contractExemptTeams ?? [];
      const isUserTeam = (tm: string) => exemptTeams.includes(tm);
      const aiManagerNameFor = (tm: string): string | null => {
        const m = state.managers?.[tm];
        if (!m) return null;
        const persona = (m.personality ?? "").trim().toUpperCase();
        if (persona === "USER CONTROLLED") return null;
        return m.name ?? tm;
      };
      void logPressTargets({
        userTeam: team, managerName, context, question: q, answer: a,
        targets: res.targets, aiManagerNameFor, isUserTeam,
      });
      applyManagerRespectDelta(team, res.respectDelta);
      applyManagerHarshnessSample(team, res.harshness);
      appendPressEntry({
        season: state.season,
        week: state.currentWeek,
        team,
        managerName,
        context,
        question: q,
        answer: a,
        summary: res.summary || undefined,
        targets: res.targets.map((t) =>
          t.kind === "team"
            ? { kind: "team", name: t.name }
            : t.kind === "player"
              ? { kind: "player", team: t.team, name: t.name }
              : { kind: "manager", team: t.team },
        ),
      });
      if (res.summary) {
        const r = res.respectDelta;
        const respectNote = r >= 4 ? ` Respect ${r >= 0 ? "+" : ""}${r} — big win.`
          : r <= -4 ? ` Respect ${r} — that hurt.`
          : r !== 0 ? ` Respect ${r >= 0 ? "+" : ""}${r}.`
          : "";
        toast(res.summary, { description: `Press effect logged.${respectNote}` });
      }
      const nextExchanges = [...exchanges, { question: q, answer: a }];
      setExchanges(nextExchanges);
      setAnswer("");
      setCurrentQuestion(null);
      const last = idx >= TOTAL_QUESTIONS - 1;
      if (last) {
        setFinishing(true);
        try {
          const recap = await recapFn({
            data: {
              team, managerName, context, brief,
              exchanges: nextExchanges,
            },
          });
          onRecap?.(recap.article);
        } catch {
          /* recap is optional */
        } finally {
          setFinishing(false);
          onClose();
        }
      } else {
        setIdx((i) => i + 1);
        // Fetch the next question, using the freshly-updated exchange list so
        // the reporter can react to what was just said and avoid repeats.
        void fetchQuestion(nextExchanges);
      }
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !finishing) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Press Conference — <span className="text-primary">{team}</span>{" "}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              ({context === "pre" ? "Pre-match" : context === "post" ? "Post-match" : "General"})
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border-l-4 border-stadium-gold bg-card px-3 py-2 text-xs">
          <div className="font-bold">{managerName} <span className="text-muted-foreground">— Respect {respect.toFixed(0)}/100</span></div>
          <p className="text-muted-foreground">Your influence multiplier this conference: <span className="font-mono">{mult.toFixed(2)}×</span> (baseline × respect).</p>
        </div>

        {error && <div className="rounded-lg border-l-4 border-highlight-red bg-card px-3 py-2 text-sm">{error}</div>}

        {!currentQuestion && loading && (
          <div className="rounded-xl border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            {exchanges.length === 0 ? "The press corps is gathering questions…" : "The next reporter is raising their hand…"}
          </div>
        )}

        {currentQuestion && (
          <div className="space-y-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              Question {idx + 1} of {TOTAL_QUESTIONS}
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-sm font-semibold leading-relaxed">{currentQuestion}</p>
            </div>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={4}
              maxLength={1200}
              placeholder="Answer in your own words. Praising or insulting a team, player, or manager will move morale or relationships in real time."
              className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              disabled={loading || finishing}
            />
            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={finishing}>
                Walk out
              </Button>
              <Button onClick={submit} disabled={loading || finishing || !answer.trim()} className="font-semibold">
                {finishing ? "Filing recap…" : loading ? "Reading the room…" : (idx >= TOTAL_QUESTIONS - 1 ? "Submit final answer" : "Submit answer")}
              </Button>
            </div>
          </div>
        )}

        {exchanges.length > 0 && (
          <div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border bg-card/50 p-2 text-xs">
            {exchanges.map((e, i) => (
              <div key={i}>
                <p className="font-semibold text-muted-foreground">Q: {e.question}</p>
                <p className="text-foreground">A: {e.answer}</p>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function formatErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  reportAiOutcome(m);
  if (m.includes("RATE_LIMIT")) return "The press corps is overloaded — try again in a moment.";
  if (m.includes("CREDITS")) return "AI credits exhausted. Add credits in Settings → Workspace → Usage.";
  return "Couldn't reach the press desk. Please try again.";
}
