// AI Boardroom Sacking Review — a lightweight server-fn that lets a language
// model decide which (if any) AI managers should be dismissed this week.
// Called by AiSackingWatcher once per week with a compact league digest. The
// model weighs standings, manager respect, team morale, average player morale,
// recent form, and press-conference tone — with standings + respect carrying
// the heaviest weight.
import { createServerFn } from "@tanstack/react-start";
import { chatCompletion } from "./ai-fallback.server";

export interface SackingCandidate {
  team: string;
  managerName: string;
  respect: number;
  harshness: number;
  standingsRank: number; // 1 = top
  totalTeams: number;
  recentForm: string; // e.g. "L L D W L"
  teamMorale: number;
  avgPlayerMorale: number;
  weeksSinceLastPress?: number;
  lastPressSummary?: string;
}

interface ReviewInput {
  season: number;
  currentWeek: number;
  candidates: SackingCandidate[];
}

export interface SackingDecision {
  team: string;
  sack: boolean;
  reason: string;
}

const REVIEW_RULES = `
You are the ownership boardroom for the Eden League clubs listed. Decide, PER CLUB, whether the manager should be sacked this week based on ALL the data provided — not just one metric.

WEIGHTING (use as a rough guide, not a formula):
- Standings position + trajectory: HEAVIEST weight. A top-of-table manager should almost never be sacked; a bottom-3 manager on a long losing streak often should be.
- Manager respect (0-100, public rating): HEAVY weight. Below 25 is a clear crisis; 25-40 is the danger zone if other factors also point down.
- Team morale (0-100): moderate weight. Very low morale + low respect + poor standings = clear sack.
- Average player morale (0-100): lighter weight — one unhappy dressing room reinforces other signals but doesn't sack alone.
- Recent form + press tone: contextual — a manager saying reckless things in press conferences AND losing is worse than one losing quietly.

RULES:
- Be conservative. Do NOT sack unless a REAL case exists across multiple signals. Most weeks most clubs should be "sack": false.
- A club sitting in the top third of the standings should virtually never be sacked, even if respect dips briefly. Give them the benefit of a rough patch.
- A club in the bottom third with respect < 30 and low team morale is a strong sack candidate.
- Never invent facts. Reason only from the data provided per club.

OUTPUT FORMAT — a JSON object exactly:
{ "decisions": [ { "team": "<team>", "sack": <boolean>, "reason": "<one short clause>" }, ... ] }
No prose outside the JSON.
`;

function extractJson<T>(content: string): T | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(content.slice(start, end + 1)) as T; } catch { return null; }
}

export const boardroomSackingReview = createServerFn({ method: "POST" })
  .inputValidator((data: ReviewInput) => {
    if (!data || !Array.isArray(data.candidates) || data.candidates.length === 0) {
      throw new Error("No candidates to review");
    }
    return data;
  })
  .handler(async ({ data }): Promise<{ decisions: SackingDecision[] }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const dataBlock = data.candidates.map((c) => {
      const pct = ((c.standingsRank / c.totalTeams) * 100).toFixed(0);
      return [
        `CLUB: ${c.team} — Manager: ${c.managerName}`,
        `  Standings: rank ${c.standingsRank}/${c.totalTeams} (top ${pct}%)`,
        `  Manager respect: ${c.respect.toFixed(1)}/100 · harshness ${c.harshness.toFixed(2)}`,
        `  Team morale: ${c.teamMorale.toFixed(0)}/100 · avg player morale ${c.avgPlayerMorale.toFixed(0)}/100`,
        `  Recent form (newest → oldest): ${c.recentForm || "(no matches)"}`,
        c.lastPressSummary ? `  Last press quote summary: "${c.lastPressSummary}"` : `  Last press quote: (none recent)`,
      ].join("\n");
    }).join("\n\n");

    const user = [
      `SEASON ${data.season} · WEEK ${data.currentWeek} — sacking review.`,
      ``,
      dataBlock,
      ``,
      `Return one decision per club. JSON object only.`,
    ].join("\n");

    const { content } = await chatCompletion({
      messages: [
        { role: "system", content: REVIEW_RULES },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      structured: true,
    });
    const parsed = extractJson<{ decisions?: unknown }>(content);
    const decisions: SackingDecision[] = [];
    const raws = Array.isArray(parsed?.decisions) ? parsed!.decisions : [];
    const validTeams = new Set(data.candidates.map((c) => c.team));
    for (const r of raws) {
      const rr = r as Record<string, unknown>;
      const team = typeof rr.team === "string" ? rr.team : "";
      if (!validTeams.has(team)) continue;
      decisions.push({
        team,
        sack: !!rr.sack,
        reason: typeof rr.reason === "string" ? rr.reason.slice(0, 200) : "",
      });
    }
    return { decisions };
  });
