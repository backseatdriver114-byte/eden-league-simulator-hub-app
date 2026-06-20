// Builds factual digests from REAL league state for the Negotiation Suite.
// Every value here is derived strictly from existing data (rosters, ratings,
// computed trade values, budgets, salary cap) — no fabricated numbers. The AI
// manager narrates only these facts.
import type { LeagueState, LeagueTeam } from "@/state/league";
import { calculatePlayerValue, parseBudget, describePickValue } from "@/lib/trades";
import { relationLabel } from "@/lib/relations";

function rosterLines(team: LeagueTeam): string {
  return team.players
    .map((p) => {
      const status =
        p.injuryWeeks > 0 ? ` [injured ${p.injuryWeeks >= 99 ? "season" : p.injuryWeeks + "wk"}]`
        : p.suspensionWeeks > 0 ? ` [suspended ${p.suspensionWeeks}wk]`
        : "";
      return `    - ${p.name} (${p.position}, age ${p.age}, rating ${p.rating.toFixed(1)}, value $${calculatePlayerValue(p)}M, ${p.contractYears}yr deal @ $${p.salary}M)${status}`;
    })
    .join("\n");
}

function payrollOf(team: LeagueTeam): number {
  return Math.round(team.players.reduce((s, p) => s + (p.salary ?? 0), 0) * 10) / 10;
}

export function buildNegotiationBrief(
  state: LeagueState,
  userTeamName: string,
  aiTeamName: string,
  rankOf?: (team: string) => number
): string | null {
  const userTeam = state.teams[userTeamName];
  const aiTeam = state.teams[aiTeamName];
  if (!userTeam || !aiTeam) return null;

  const cap = state.salaryCap ?? 0;
  const totalTeams = state.teamOrder.length;
  const rank = (team: string) => {
    const r = rankOf?.(team);
    return r && r > 0 ? r : Math.ceil(totalTeams / 2);
  };
  const ownedPickLines = (team: string): string => {
    const picks = (state.draftPicks ?? []).filter((pk) => pk.owner === team);
    if (!picks.length) return "none";
    return "\n" + picks.map((pk) => `    - ${describePickValue(pk, rank(pk.originalTeam), totalTeams)}`).join("\n");
  };

  const userMgrRaw = state.managers?.[userTeamName]?.name?.trim();
  const userMgr =
    userMgrRaw && userMgrRaw.toUpperCase() !== "USER CONTROLLED" ? userMgrRaw : null;
  const userLabel = userMgr
    ? `${userTeamName} (the USER's club, managed by ${userMgr})`
    : `${userTeamName} (the USER's club)`;

  return [
    `SALARY CAP: $${cap}M hard cap (a club's total payroll cannot exceed this after a trade).`,
    ``,
    `${userLabel} — tactical style "${userTeam.tactical_style}":`,
    `  Transfer budget: ${userTeam.budget}. Current payroll: $${payrollOf(userTeam)}M.`,
    `  Roster:`,
    rosterLines(userTeam),
    `  Draft picks owned: ${ownedPickLines(userTeamName)}`,
    ``,
    `${aiTeamName} (YOUR club) — tactical style "${aiTeam.tactical_style}":`,
    `  Transfer budget: ${aiTeam.budget}. Current payroll: $${payrollOf(aiTeam)}M.`,
    `  Roster:`,
    rosterLines(aiTeam),
    `  Draft picks owned: ${ownedPickLines(aiTeamName)}`,
    ``,
    `RELATIONSHIP WITH THE USER MANAGER: ${
      typeof state.relations?.[aiTeamName] === "number"
        ? `${(state.relations![aiTeamName] as number).toFixed(0)}/100 — ${relationLabel(state.relations![aiTeamName] as number).toLowerCase()}. Let this color your tone (warm = friendlier banter; frosty = clipped, suspicious). It does NOT change whether you accept a fair deal — even rivals shake hands on a good trade.`
        : `neutral (no prior history). Be polite but professional.`
    }`,
    ``,
    `Note: player "value" is the league's fair-market valuation in $M. Use it to judge whether a deal is fair, a steal, or an overpay.`,
    `DRAFT PICK VALUATION: Prospect overalls run ~7.4 (rare elites) down to ~3.0, with far more weak prospects than strong ones. The draft is reverse-standings, so judge each pick by its LIKELY slot (shown above): an early pick from a weak club can land a 7.0+ talent and is genuinely valuable; a late pick from a strong club likely yields a sub-5.0 prospect and is worth little. Picks are especially attractive to budget-strapped clubs (rookies sign cheap $2M/2yr deals). Weigh a pick's expected prospect OVR against the players involved — never treat all picks as equally valuable.`,
  ].join("\n");
}

// Convenience: budget as a number for client-side guardrails/UI.
export function budgetM(team: LeagueTeam): number {
  return parseBudget(team.budget);
}
