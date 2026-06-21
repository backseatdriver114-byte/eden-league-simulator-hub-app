// Behind-the-scenes weekly AI press conferences. Always mounted. When the
// league rolls into a new week, this watcher runs one short press conference
// for every AI-controlled (non user-exempt) club covering the week that just
// finished. Results are appended to the public press archive, target effects
// applied (morale/relations/respect), and a notification surfaces whenever
// any user-controlled team is mentioned.
import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useLeague } from "@/state/league";
import { buildPressBrief } from "@/lib/press-brief";
import { runAiPressConference, type PressTarget } from "@/lib/press-conference.functions";
import { reportAiOutcome } from "@/lib/ai-status";
import { publishAppNotif } from "@/lib/app-notifications";

const SCAN_KEY = "ai-press-last-week";

export function AiPressConferenceWatcher() {
  const {
    state, standings, leaderboards,
    appendPressEntry, applyTeamMoraleDelta, applyPlayerMoraleDelta,
    applyRelationDelta, applyManagerRespectDelta, applyManagerHarshnessSample,
  } = useLeague();
  const runFn = useServerFn(runAiPressConference);
  const runningRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const exempt = state.settings?.contractExemptTeams ?? [];
    const isUserTeam = (t: string) => exempt.includes(t);
    // Conference covers the previous week (the one that just finished).
    const coveredWeek = (state.currentWeek ?? 1) - 1;
    if (coveredWeek < 1) return;
    const scanKey = `S${state.season ?? 1}W${coveredWeek}`;
    try {
      const last = typeof window !== "undefined" ? window.localStorage.getItem(SCAN_KEY) : null;
      if (last === scanKey) return;
    } catch { /* ignore */ }
    if (runningRef.current) return;

    const aiTeams = state.teamOrder.filter((t) => {
      if (isUserTeam(t)) return false;
      const m = state.managers?.[t];
      if (!m) return false;
      const persona = (m.personality ?? "").trim().toUpperCase();
      if (persona === "USER CONTROLLED") return false;
      if (m.name === "Interim Manager") return false;
      if (m.pendingGeneration) return false;
      return true;
    });
    if (aiTeams.length === 0) return;
    runningRef.current = true;

    void (async () => {
      // Build VALID lists once (cheap and reused for every conference).
      const validTeams = state.teamOrder;
      const validManagers = state.teamOrder
        .map((tm) => ({ team: tm, name: state.managers?.[tm]?.name ?? tm }))
        .filter((m) => m.name && m.name.toUpperCase() !== "USER CONTROLLED");
      const validPlayers: { team: string; name: string }[] = [];
      for (const tm of state.teamOrder) {
        for (const p of state.teams[tm]?.players ?? []) validPlayers.push({ team: tm, name: p.name });
      }

      for (const team of aiTeams) {
        const manager = stateRef.current.managers?.[team];
        if (!manager) continue;
        const brief = buildPressBrief({
          state: stateRef.current, standings, leaderboards, team, context: "general",
        });
        if (!brief) continue;
        try {
          const res = await runFn({
            data: {
              team,
              managerName: manager.name ?? team,
              managerPersonality: manager.personality,
              brief,
              validTeams, validManagers, validPlayers,
            },
          });
          if (res.exchanges.length === 0) continue;

          // Apply target effects (slightly damped for AI presses since they
          // happen every week for 23 clubs).
          const baseInfluence = stateRef.current.settings?.pressInfluenceBaseline ?? 1;
          const respectScale = Math.max(0.4, Math.min(1.6, (manager.respect ?? 50) / 50));
          const mult = baseInfluence * respectScale * 0.6;
          applyTargets(res.targets, team, mult, {
            applyTeamMoraleDelta, applyPlayerMoraleDelta, applyRelationDelta, stateRef,
          });
          applyManagerRespectDelta(team, res.respectDelta);
          applyManagerHarshnessSample(team, res.harshness);

          // Append every exchange to the public archive.
          const archiveTargets = res.targets.map((t) =>
            t.kind === "team" ? { kind: "team" as const, name: t.name }
            : t.kind === "player" ? { kind: "player" as const, team: t.team, name: t.name }
            : { kind: "manager" as const, team: t.team });
          for (const ex of res.exchanges) {
            appendPressEntry({
              season: stateRef.current.season,
              week: coveredWeek,
              team,
              managerName: manager.name ?? team,
              context: "post",
              question: ex.question,
              answer: ex.answer,
              summary: res.summary || undefined,
              targets: archiveTargets,
            });
          }

          // Notification when a user-controlled team is mentioned.
          const mentioned = new Set<string>();
          for (const t of res.targets) {
            if (t.kind === "team" && isUserTeam(t.name)) mentioned.add(t.name);
            else if (t.kind === "player" && isUserTeam(t.team)) mentioned.add(t.team);
            else if (t.kind === "manager" && isUserTeam(t.team)) mentioned.add(t.team);
          }
          for (const userTeam of mentioned) {
            publishAppNotif({
              kind: "press-mention",
              title: `${manager.name ?? team} mentioned you in a press conference`,
              detail: `${manager.name ?? team} of ${team} brought up ${userTeam}${res.summary ? ` — "${res.summary}"` : ""}.`,
            });
          }
          // Tiny delay between teams to be kind to the gateway.
          await new Promise((r) => setTimeout(r, 400));
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          reportAiOutcome(m);
          if (m.includes("CREDITS")) break; // stop the scan — no point burning more calls
          // Otherwise just skip this team and continue.
        }
      }
      try { window.localStorage.setItem(SCAN_KEY, scanKey); } catch { /* ignore */ }
      runningRef.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentWeek, state.season]);

  return null;
}

interface ApplyDeps {
  applyTeamMoraleDelta: (team: string, delta: number) => void;
  applyPlayerMoraleDelta: (team: string, name: string, delta: number) => void;
  applyRelationDelta: (team: string, delta: number) => void;
  stateRef: { current: ReturnType<typeof useLeague>["state"] };
}

function applyTargets(targets: PressTarget[], speakerTeam: string, mult: number, deps: ApplyDeps) {
  for (const t of targets) {
    if (t.kind === "team") {
      const sameTeam = t.name === speakerTeam ? 1.5 : 1.0;
      deps.applyTeamMoraleDelta(t.name, Math.round(t.moraleDelta * mult * sameTeam));
    } else if (t.kind === "player") {
      if (t.team === speakerTeam) {
        deps.applyPlayerMoraleDelta(t.team, t.name, Math.round(t.moraleDelta * mult * 1.5));
      } else {
        const player = deps.stateRef.current.teams[t.team]?.players.find((p) => p.name === t.name);
        const rating = player?.rating ?? 6;
        const ratingCap = Math.max(0, 1 - Math.max(0, rating - 6) / 4);
        deps.applyPlayerMoraleDelta(t.team, t.name, Math.round(t.moraleDelta * mult * ratingCap));
      }
    } else if (t.kind === "manager") {
      // AI speaker talking about a manager. Relations are USER↔AI, so we only
      // update if the TARGET is a user-controlled team — and we record the
      // shift against the SPEAKER's relationship score.
      const targetMgr = deps.stateRef.current.managers?.[t.team];
      if (!targetMgr) continue;
      if ((targetMgr.personality ?? "").trim().toUpperCase() !== "USER CONTROLLED") continue;
      deps.applyRelationDelta(speakerTeam, t.relationDelta * mult);
    }
  }
}
