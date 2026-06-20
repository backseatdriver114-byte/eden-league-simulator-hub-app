import { useMemo, useRef, useState } from "react";
import { reportAiOutcome } from "@/lib/ai-status";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useLeague } from "@/state/league";
import { buildScheduleBrief } from "@/lib/schedule-brief";
import { fetchRecentSeasonSummaries } from "@/lib/league-history";
import { generateSchedule, fixScheduleWeek, type SpecialRequest } from "@/lib/schedule-ai.functions";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

interface Draft {
  key: string;
  week: number;
  home: string;
  away: string;
}

const pairKey = (a: string, b: string) => [a, b].sort().join(" ⚔ ");
const newKey = () => `${Date.now()}-${Math.random()}`;

export function FixtureBuilder({
  weeks,
  title,
  onSaved,
  commit,
  saveLabelOverride,
  phase = "regular",
}: {
  weeks: number[];
  title: string;
  onSaved?: () => void;
  commit?: (entries: { week: number; home: string; away: string }[]) => void;
  saveLabelOverride?: string;
  phase?: "regular" | "finalfour";
}) {
  const { state, standings, addFixtures } = useLeague();
  const teams = state.teamOrder;
  const perWeekMatches = Math.floor(teams.length / 2);

  const [week, setWeek] = useState(weeks[0]);
  const [home, setHome] = useState(teams[0]);
  const [away, setAway] = useState(teams[1]);
  const [drafts, setDrafts] = useState<Draft[]>([]);

  // --- AI generation ---
  const runGenerate = useServerFn(generateSchedule);
  const runFix = useServerFn(fixScheduleWeek);
  const [genHome, setGenHome] = useState<string>("");
  const [genAway, setGenAway] = useState<string>("");
  const [genWeek, setGenWeek] = useState<string>(""); // "" = any week
  const [requests, setRequests] = useState<SpecialRequest[]>([]);
  const [genLoading, setGenLoading] = useState(false);
  const [fixLoading, setFixLoading] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Validation dialogs
  const [errorReport, setErrorReport] = useState<{ messages: string[]; gotoWeek: number } | null>(null);
  const [warnReport, setWarnReport] = useState<string[] | null>(null);
  const [highlightWeek, setHighlightWeek] = useState<number | null>(null);
  const weekRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const sameTeam = home === away;
  const genSameTeam = genHome !== "" && genHome === genAway;
  const canAddRequest = genHome !== "" && genAway !== "" && !genSameTeam;

  function add() {
    if (sameTeam) return;
    setDrafts((prev) => [...prev, { key: newKey(), week, home, away }]);
  }

  function remove(key: string) {
    setDrafts((prev) => prev.filter((d) => d.key !== key));
  }

  function addRequest() {
    if (!canAddRequest) return;
    setRequests((prev) => [
      ...prev,
      { home: genHome, away: genAway, week: genWeek ? Number(genWeek) : null },
    ]);
    setGenHome("");
    setGenAway("");
    setGenWeek("");
  }

  function removeRequest(i: number) {
    setRequests((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function generate() {
    setGenError(null);
    setGenLoading(true);
    try {
      // Pull the last few archived seasons so the AI can favor genuine rivalries
      // and reference recent finalists when balancing the new fixture list.
      const history = await fetchRecentSeasonSummaries(3);
      const brief = buildScheduleBrief(state, standings, phase, history || undefined);
      const res = await runGenerate({
        data: {
          phase,
          teams,
          weeks,
          perWeek: perWeekMatches,
          specialRequests: requests,
          brief,
        },
      });
      const seeded: Draft[] = res.fixtures
        .filter((f) => weeks.includes(f.week))
        .map((f) => ({ key: newKey(), week: f.week, home: f.home, away: f.away }));
      setDrafts(seeded);
      toast.success("AI schedule generated", {
        description: "Review and hand-edit below, then save. We'll flag any conflicts.",
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      reportAiOutcome(m);
      if (m.includes("RATE_LIMIT")) setGenError("The fixture computer is busy — try again in a moment.");
      else if (m.includes("CREDITS")) setGenError("AI credits exhausted. Add credits in Settings → Workspace → Usage.");
      else setGenError("Couldn't generate a schedule. Try again, or build it manually below.");
    } finally {
      setGenLoading(false);
    }
  }

  // --- Hard validation: blocks saving until every week is complete & balanced ---
  function validateSchedule(): { messages: string[]; gotoWeek: number } | null {
    for (const w of weeks) {
      const list = drafts.filter((d) => d.week === w);
      const appear = new Map<string, number>();
      for (const d of list) {
        appear.set(d.home, (appear.get(d.home) ?? 0) + 1);
        appear.set(d.away, (appear.get(d.away) ?? 0) + 1);
      }
      const msgs: string[] = [];
      if (list.length !== perWeekMatches) {
        msgs.push(
          `Week ${w} has ${list.length} match${list.length === 1 ? "" : "es"}, but every week must have exactly ${perWeekMatches} (so all ${teams.length} clubs play once).`,
        );
      }
      const dupes = teams.filter((t) => (appear.get(t) ?? 0) > 1);
      const missing = teams.filter((t) => !(appear.get(t) ?? 0));
      if (dupes.length) msgs.push(`Week ${w}: ${dupes.join(", ")} ${dupes.length === 1 ? "is" : "are"} scheduled more than once.`);
      if (missing.length) msgs.push(`Week ${w}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not scheduled.`);
      if (msgs.length) return { messages: msgs, gotoWeek: w };
    }
    return null;
  }

  // --- Soft warning: rematches (a pairing that appears more than once) ---
  function rematchWarnings(): string[] {
    const seen = new Map<string, number>();
    for (const d of drafts) seen.set(pairKey(d.home, d.away), (seen.get(pairKey(d.home, d.away)) ?? 0) + 1);
    const out: string[] = [];
    for (const [k, c] of seen) if (c > 1) out.push(`${k.replace(" ⚔ ", " vs ")} appears ${c} times in this schedule.`);
    return out;
  }

  function commitNow() {
    const entries = drafts.map(({ week, home, away }) => ({ week, home, away }));
    if (commit) commit(entries);
    else addFixtures(entries);
    setDrafts([]);
    setWarnReport(null);
    onSaved?.();
  }

  function save() {
    if (drafts.length === 0) return;
    const err = validateSchedule();
    if (err) { setErrorReport(err); return; }
    const warns = rematchWarnings();
    if (warns.length) { setWarnReport(warns); return; }
    commitNow();
  }

  function acknowledgeError() {
    if (!errorReport) return;
    const target = errorReport.gotoWeek;
    setWeek(target);
    setHighlightWeek(target);
    setErrorReport(null);
    // Scroll the offending week into view so the user lands right on the problem.
    requestAnimationFrame(() => {
      weekRefs.current[target]?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  async function aiFixConflict() {
    if (!errorReport) return;
    const target = errorReport.gotoWeek;
    setFixLoading(true);
    try {
      const current = drafts.filter((d) => d.week === target).map((d) => ({ home: d.home, away: d.away }));
      const res = await runFix({
        data: { week: target, teams, perWeek: perWeekMatches, current },
      });
      // Replace ONLY this week's drafts with the AI-corrected set.
      setDrafts((prev) => [
        ...prev.filter((d) => d.week !== target),
        ...res.fixtures.map((f) => ({ key: newKey(), week: target, home: f.home, away: f.away })),
      ]);
      setErrorReport(null);
      // Re-validate; if other weeks still conflict, surface the next one.
      requestAnimationFrame(() => {
        const next = validateSchedule();
        if (next) setErrorReport(next);
        else toast.success(`Week ${target} fixed`, { description: "The conflict was resolved automatically." });
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      reportAiOutcome(m);
      if (m.includes("RATE_LIMIT")) toast.error("AI is busy", { description: "Try again in a moment." });
      else if (m.includes("CREDITS")) toast.error("AI credits exhausted", { description: "Add credits in Settings → Workspace → Usage." });
      else toast.error("Couldn't auto-fix", { description: "Please adjust this week manually." });
    } finally {
      setFixLoading(false);
    }
  }

  const byWeek = useMemo(() => {
    const map = new Map<number, Draft[]>();
    for (const w of weeks) map.set(w, []);
    for (const d of drafts) {
      if (!map.has(d.week)) map.set(d.week, []);
      map.get(d.week)!.push(d);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [drafts, weeks]);

  // Flag teams already used twice / duplicate matchups within the selected week.
  const warnings = useMemo(() => {
    const w = drafts.filter((d) => d.week === week);
    const count = new Map<string, number>();
    const out: string[] = [];
    for (const d of w) {
      count.set(d.home, (count.get(d.home) ?? 0) + 1);
      count.set(d.away, (count.get(d.away) ?? 0) + 1);
    }
    for (const [t, c] of count) if (c > 1) out.push(`${t} appears ${c}× in Week ${week}`);
    return out;
  }, [drafts, week]);

  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide">{title}</h3>

      {/* ---- AI schedule generator ---- */}
      <div className="mb-5 rounded-lg border border-dashed bg-panel/40 p-3">
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
          ✨ AI Schedule Generator
        </div>
        <p className="mb-3 text-[11px] text-muted-foreground">
          {phase === "finalfour"
            ? "Generates dramatic Final Four matchups from current standings (best vs best). Add any must-have matchups below first."
            : "Generates a balanced, exciting 12-week schedule from squad strength & archive data. Add any special-request matchups below first."}
        </p>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_auto] sm:items-end">
          <Field label="Home (request)">
            <TeamSelectOptional value={genHome} teams={teams} onChange={setGenHome} placeholder="Pick club" />
          </Field>
          <span className="hidden pb-2 text-center font-bold text-muted-foreground sm:block">vs</span>
          <Field label="Away (request)">
            <TeamSelectOptional value={genAway} teams={teams} onChange={setGenAway} placeholder="Pick club" />
          </Field>
          <Field label="Week (optional)">
            <Select value={genWeek || "__any__"} onValueChange={(v) => setGenWeek(v === "__any__" ? "" : v)}>
              <SelectTrigger className="w-full bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any__">Any week</SelectItem>
                {weeks.map((w) => <SelectItem key={w} value={String(w)}>Week {w}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {canAddRequest && (
            <Button variant="secondary" onClick={addRequest} className="font-semibold">ADD FIXTURE</Button>
          )}
        </div>
        {genSameTeam && <p className="mt-2 text-xs text-destructive">A requested matchup needs two different clubs.</p>}

        {requests.length > 0 && (
          <ul className="mt-3 space-y-1">
            {requests.map((r, i) => (
              <li key={`${r.home}-${r.away}-${i}`} className="flex items-center justify-between gap-2 rounded-md bg-card px-2.5 py-1.5 text-xs">
                <span className="font-medium">
                  {r.home} <span className="text-muted-foreground">vs</span> {r.away}
                  <span className="ml-2 text-muted-foreground">{r.week ? `· Week ${r.week}` : "· any week"}</span>
                </span>
                <button onClick={() => removeRequest(i)} className="font-semibold text-destructive hover:underline">remove</button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex items-center gap-3">
          <Button onClick={generate} disabled={genLoading} className="font-semibold">
            {genLoading ? "Generating…" : "GENERATE SCHEDULE"}
          </Button>
          {requests.length > 0 && (
            <span className="text-[11px] text-muted-foreground">{requests.length} special request{requests.length === 1 ? "" : "s"} queued</span>
          )}
        </div>
        {genError && <p className="mt-2 text-xs text-destructive">{genError}</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-[auto_1fr_auto_1fr_auto] sm:items-end">
        <Field label="Week">
          <Select value={String(week)} onValueChange={(v) => { setWeek(Number(v)); setHighlightWeek(null); }}>
            <SelectTrigger className="w-full bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              {weeks.map((w) => <SelectItem key={w} value={String(w)}>Week {w}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Home">
          <TeamSelect value={home} teams={teams} onChange={setHome} />
        </Field>
        <span className="hidden pb-2 text-center font-bold text-muted-foreground sm:block">vs</span>
        <Field label="Away">
          <TeamSelect value={away} teams={teams} onChange={setAway} />
        </Field>
        <Button onClick={add} disabled={sameTeam} className="font-semibold">ADD</Button>
      </div>
      {sameTeam && (
        <p className="mt-2 text-xs text-destructive">Home and Away must differ.</p>
      )}
      {warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-destructive">
          {warnings.map((w) => <li key={w}>⚠ {w}</li>)}
        </ul>
      )}

      <div className="mt-4 space-y-3">
        {byWeek.map(([w, list]) => {
          const isHighlighted = highlightWeek === w;
          const complete = list.length === perWeekMatches;
          return (
            <div
              key={w}
              ref={(el) => { weekRefs.current[w] = el; }}
              className={`scroll-mt-24 rounded-lg border p-3 transition-colors ${
                isHighlighted
                  ? "border-destructive bg-destructive/10 ring-2 ring-destructive"
                  : "border-border bg-panel/40"
              }`}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs font-bold uppercase tracking-wide">
                <span className="text-muted-foreground">
                  Week {w} · {list.length}/{perWeekMatches} {list.length === 1 ? "match" : "matches"}
                </span>
                <span className={complete ? "text-primary" : "text-destructive"}>
                  {complete ? "✓ balanced" : "incomplete"}
                </span>
              </div>
              {list.length === 0 ? (
                <p className="text-xs text-muted-foreground">No fixtures added yet.</p>
              ) : (
                <ul className="divide-y">
                  {list.map((d) => (
                    <li key={d.key} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="font-medium">{d.home} <span className="text-muted-foreground">vs</span> {d.away}</span>
                      <button
                        onClick={() => remove(d.key)}
                        className="text-xs font-semibold text-destructive hover:underline"
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex justify-end">
        <Button onClick={save} disabled={drafts.length === 0} className="px-6 font-semibold">
          {saveLabelOverride ?? `SAVE ${drafts.length} FIXTURE${drafts.length === 1 ? "" : "S"}`}
        </Button>
      </div>

      {/* Hard error — blocks saving until fixed */}
      <Dialog open={!!errorReport} onOpenChange={(o) => { if (!o && !fixLoading) acknowledgeError(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-destructive">⛔ Schedule conflict in Week {errorReport?.gotoWeek}</DialogTitle>
            <DialogDescription>
              Every week must have exactly {perWeekMatches} matches with each club playing once. Fix it yourself, or let
              the AI repair this week with minimal changes:
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1.5 text-sm text-foreground">
            {errorReport?.messages.map((m, i) => <li key={i}>• {m}</li>)}
          </ul>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={acknowledgeError} disabled={fixLoading} className="font-semibold">
              Change Manually
            </Button>
            <Button onClick={aiFixConflict} disabled={fixLoading} className="font-semibold">
              {fixLoading ? "Fixing…" : "Use AI to Fix Conflict"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Soft warning — rematches, bypassable */}
      <Dialog open={!!warnReport} onOpenChange={(o) => { if (!o) setWarnReport(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-accent-foreground">⚠ Possible rematch detected</DialogTitle>
            <DialogDescription>
              The schedule is valid and balanced, but some clubs are set to face each other more than once:
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1.5 text-sm text-foreground">
            {warnReport?.map((m, i) => <li key={i}>• {m}</li>)}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWarnReport(null)}>Go back and edit</Button>
            <Button onClick={commitNow} className="font-semibold">Schedule anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function TeamSelect({
  value, teams, onChange,
}: {
  value: string; teams: string[]; onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full bg-card"><SelectValue /></SelectTrigger>
      <SelectContent>
        {teams.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function TeamSelectOptional({
  value, teams, onChange, placeholder,
}: {
  value: string; teams: string[]; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full bg-card"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {teams.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
