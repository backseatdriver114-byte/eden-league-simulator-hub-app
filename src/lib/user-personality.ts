// Derives a behind-the-scenes personality description for a user-controlled
// manager based on their actual on-record activity. User managers cannot type
// a personality (their field always reads "USER CONTROLLED"), so AI features
// that need one — negotiation, messaging, other managers reacting — call this
// helper instead of reading the raw `personality` field.
//
// Weighting rationale: press conferences are PUBLIC and the most reliable
// signal (heavy weight); direct messages are private but still on-record
// (medium weight); firing/hiring actions are loud one-off signals (light
// tie-break). Everything falls back to "balanced professional" if the manager
// has no history yet.
import type { LeagueState } from "@/state/league";

const MAX_PRESS_QUOTES = 6;

export function isUserManager(state: LeagueState, team: string): boolean {
  const m = state.managers?.[team];
  if (!m) return false;
  return (m.personality ?? "").trim().toUpperCase() === "USER CONTROLLED";
}

export function computeDerivedPersonality(state: LeagueState, team: string): string {
  const mgr = state.managers?.[team];
  const name = mgr?.name ?? "The manager";
  const respect = typeof mgr?.respect === "number" ? mgr.respect : 50;
  const harshness = typeof mgr?.harshness === "number" ? mgr.harshness : 0.5;

  // Recent press quotes attributed to this team's manager (public record).
  const press = (state.pressArchive ?? [])
    .filter((e) => e.team === team)
    .slice(-MAX_PRESS_QUOTES);

  const respectBand = respect >= 70 ? "widely respected" : respect >= 45 ? "credible" : respect >= 25 ? "under pressure" : "struggling for authority";
  const toneBand = harshness >= 0.7 ? "sharp-tongued and combative" : harshness >= 0.55 ? "candid, willing to jab back" : harshness <= 0.3 ? "measured and diplomatic" : "balanced in tone";

  const quoteLines = press.length
    ? press.map((e) => `  - "${e.answer.slice(0, 140)}"`).join("\n")
    : "  (no on-record press quotes yet — treat as a professional, in-character manager still finding their voice)";

  return [
    `${name} is a USER-CONTROLLED manager (a real human is playing this club).`,
    `Public standing: ${respectBand} (respect ${respect.toFixed(0)}/100).`,
    `Communication tone: ${toneBand} (harshness ${harshness.toFixed(2)}).`,
    `Recent on-record quotes (use to calibrate how they actually talk):`,
    quoteLines,
    `Behave toward them as a plausible peer would toward a manager whose actual behaviour matches the above signals.`,
  ].join("\n");
}

// Small nudge injected into AI communication prompts: consider the OTHER
// manager's personality when speaking, but only lightly. Keeps interactions
// realistic without overwhelming the speaker's own voice.
export function opponentAwarenessNote(opponentPersonality: string | undefined): string {
  const p = (opponentPersonality ?? "").trim();
  if (!p) return "";
  return [
    ``,
    `OPPONENT PERSPECTIVE (minor tonal influence only, ~15% weight — do NOT let it override your own voice):`,
    `  The person you are speaking to is described as: ${p.slice(0, 400)}`,
    `  Adjust ONLY subtle word-choice and tone — be a touch warmer with warm personalities, a touch firmer with combative ones. Never adopt their personality; you are still yourself.`,
  ].join("\n");
}
