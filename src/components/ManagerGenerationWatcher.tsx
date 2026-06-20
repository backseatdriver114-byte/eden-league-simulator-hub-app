import { useEffect, useRef } from "react";
import { useLeague } from "@/state/league";
import { useServerFn } from "@tanstack/react-start";
import { generateManager } from "@/lib/negotiation.functions";

// Always-mounted watcher: when an AI club's manager is sacked, the state layer
// flags that club's manager with `pendingGeneration`. This component detects
// those flags and asks Lovable AI for a fresh in-character manager, then writes
// it back into league state. User-controlled clubs are never sacked, so they
// never appear here. Failures are silent and harmless — the interim manager
// simply remains until the next attempt.
export function ManagerGenerationWatcher() {
  const { state, replaceManager } = useLeague();
  const run = useServerFn(generateManager);
  const inFlight = useRef<Set<string>>(new Set());
  // Per-team cooldown timestamps: after a failed generation we wait before
  // retrying so a rate-limited / down gateway is never hammered on every
  // subsequent state change.
  const cooldownUntil = useRef<Map<string, number>>(new Map());
  const RETRY_COOLDOWN_MS = 60_000;

  useEffect(() => {
    const pending = Object.entries(state.managers ?? {}).filter(
      ([, m]) => m.pendingGeneration
    );
    const now = Date.now();
    // Build the universe of names that the new manager must NOT collide with:
    // every other manager (skipping interim/pending entries and the literal
    // "USER CONTROLLED" placeholder) plus every player name in the league.
    const takenNames: string[] = [];
    for (const [team, m] of Object.entries(state.managers ?? {})) {
      const name = m?.name?.trim();
      if (!name) continue;
      if (m.pendingGeneration) continue;
      if (name.toUpperCase() === "USER CONTROLLED") continue;
      if (name === "Interim Manager") continue;
      takenNames.push(name);
      // belt-and-braces: include the team name itself
      takenNames.push(team);
    }
    for (const t of Object.values(state.teams ?? {})) {
      for (const p of t.players ?? []) {
        if (p.name) takenNames.push(p.name);
      }
    }
    for (const [team] of pending) {
      if (inFlight.current.has(team)) continue;
      const until = cooldownUntil.current.get(team) ?? 0;
      if (now < until) continue; // still cooling down from a recent failure
      inFlight.current.add(team);
      const tacticalStyle = state.teams[team]?.tactical_style;
      run({ data: { team, tacticalStyle, takenNames } })
        .then((res) => {
          cooldownUntil.current.delete(team);
          replaceManager(team, { name: res.name, personality: res.personality });
        })
        .catch(() => {
          // Back off before the next attempt; the interim manager stays in place.
          cooldownUntil.current.set(team, Date.now() + RETRY_COOLDOWN_MS);
        })
        .finally(() => {
          inFlight.current.delete(team);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.managers]);

  return null;
}
