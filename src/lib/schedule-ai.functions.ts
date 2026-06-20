import { createServerFn } from "@tanstack/react-start";

// AI fixture generation + conflict repair for the Match Scheduling suite.
// These functions only PROPOSE fixtures as plain data — the client validates
// and the user can still hand-edit before saving. No league state is mutated.

import { chatCompletion } from "./ai-fallback.server";

export interface SpecialRequest {
  home: string;
  away: string;
  week?: number | null;
}

interface GenerateInput {
  phase: "regular" | "finalfour";
  teams: string[];
  weeks: number[];
  perWeek: number; // matches per week (teams/2)
  specialRequests: SpecialRequest[];
  brief: string; // factual digest assembled on the client
}

interface FixScheduleWeekInput {
  week: number;
  teams: string[]; // all clubs that must appear exactly once
  perWeek: number;
  current: { home: string; away: string }[]; // the conflicted week as-is
  brief?: string;
}

export interface AiFixture {
  week: number;
  home: string;
  away: string;
}

function extractJson<T>(content: string): T | null {
  // Prefer a fenced/loose array or object; grab the outermost bracket pair.
  const tryParse = (s: string): T | null => { try { return JSON.parse(s) as T; } catch { return null; } };
  const objStart = content.indexOf("{");
  const arrStart = content.indexOf("[");
  // Whole-string attempt first.
  const whole = tryParse(content.trim());
  if (whole) return whole;
  if (arrStart !== -1) {
    const end = content.lastIndexOf("]");
    if (end > arrStart) { const r = tryParse(content.slice(arrStart, end + 1)); if (r) return r; }
  }
  if (objStart !== -1) {
    const end = content.lastIndexOf("}");
    if (end > objStart) { const r = tryParse(content.slice(objStart, end + 1)); if (r) return r; }
  }
  return null;
}

async function callGateway(_apiKey: string, system: string, user: string, temperature: number) {
  const { content } = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
    structured: true,
    timeoutMs: 45_000,
  });
  return content;
}


const GEN_SYSTEM = `You are the Eden League's fixture computer. You build a valid, balanced soccer schedule and output it as strict JSON.

HARD CONSTRAINTS (never violate):
- Every listed week must contain EXACTLY the required number of matches.
- In each week, every club plays EXACTLY ONCE (no club appears twice in the same week, no club sits out).
- Home and away in a match must be two different clubs.
- Honour every SPECIAL REQUEST: if a requested matchup has a week, place it in that week; if it has no week, place it in any week. Never drop a special request.
- Avoid scheduling the same pairing twice across the whole set of weeks unless a special request forces it.

OUTPUT FORMAT (critical):
- Output ONLY a JSON array, nothing else. Each element: {"week": <number>, "home": "<club>", "away": "<club>"}.
- Use club names EXACTLY as given. No markdown, no prose, no trailing commentary.`;

const FIX_SYSTEM = `You are the Eden League's fixture fixer. You receive ONE week of a schedule that currently has a conflict (a club playing twice, a club missing, or the wrong number of matches). You repair it with the MINIMUM possible changes.

HARD CONSTRAINTS:
- The fixed week must contain EXACTLY the required number of matches, with every club playing EXACTLY ONCE.
- Change as FEW games as possible. If swapping a single pairing resolves the conflict, change only that one. Preserve every already-valid game untouched.
- Home/away must be two different clubs.

OUTPUT FORMAT (critical):
- Output ONLY a JSON array of the corrected week's matches: [{"home": "<club>", "away": "<club>"}, ...]. No prose, no markdown.`;

export const generateSchedule = createServerFn({ method: "POST" })
  .inputValidator((data: GenerateInput) => {
    if (!data || !Array.isArray(data.teams) || data.teams.length === 0) throw new Error("Missing teams");
    if (!Array.isArray(data.weeks) || data.weeks.length === 0) throw new Error("Missing weeks");
    return data;
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const reqLines = data.specialRequests.length
      ? data.specialRequests
          .map((r) => `  - ${r.home} vs ${r.away}${r.week ? ` (must be in Week ${r.week})` : " (any week)"}`)
          .join("\n")
      : "  - (none)";

    const goal =
      data.phase === "finalfour"
        ? `This is the FINAL FOUR (Weeks ${data.weeks.join(", ")}). Make the matchups as DRAMATIC and high-stakes as possible using the standings/form data: pit the best against the best and the worst against the worst. Do NOT worry about fairness or equal difficulty — reward the table.`
        : `This is the REGULAR SEASON (Weeks ${data.weeks.join(", ")}). Build an exciting but as-fair-as-possible schedule using the squad-strength and last-season data: spread tough and easy opponents so no club gets a wildly harder run than the rest. Perfect equality is impossible — just keep it reasonably balanced and entertaining.`;

    const user = [
      `CLUBS (${data.teams.length}): ${data.teams.join(", ")}`,
      `WEEKS: ${data.weeks.join(", ")} · MATCHES PER WEEK: ${data.perWeek}`,
      ``,
      goal,
      ``,
      `SPECIAL REQUESTS (must all be honoured):`,
      reqLines,
      ``,
      `DATA:`,
      data.brief,
      ``,
      `Return the full schedule as a JSON array now.`,
    ].join("\n");

    const content = await callGateway(apiKey, GEN_SYSTEM, user, 0.7);
    const parsed = extractJson<AiFixture[] | { fixtures?: AiFixture[] }>(content);
    const list = Array.isArray(parsed) ? parsed : parsed?.fixtures;
    if (!Array.isArray(list)) throw new Error("AI returned an unreadable schedule");
    const teamSet = new Set(data.teams);
    const fixtures = list
      .filter((f) => f && typeof f.week === "number" && teamSet.has(f.home) && teamSet.has(f.away) && f.home !== f.away)
      .map((f) => ({ week: f.week, home: f.home, away: f.away }));
    if (fixtures.length === 0) throw new Error("AI returned no valid fixtures");
    return { fixtures };
  });

export const fixScheduleWeek = createServerFn({ method: "POST" })
  .inputValidator((data: FixScheduleWeekInput) => {
    if (!data || !Array.isArray(data.teams) || data.teams.length === 0) throw new Error("Missing teams");
    if (!Array.isArray(data.current)) throw new Error("Missing current week");
    return data;
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const cur = data.current.length
      ? data.current.map((m) => `  - ${m.home} vs ${m.away}`).join("\n")
      : "  - (empty)";

    const user = [
      `WEEK ${data.week} needs EXACTLY ${data.perWeek} matches, with each of these ${data.teams.length} clubs playing once:`,
      `  ${data.teams.join(", ")}`,
      ``,
      `CURRENT (conflicted) WEEK ${data.week}:`,
      cur,
      ``,
      `Repair it with the fewest possible changes and return ONLY the corrected JSON array.`,
    ].join("\n");

    const content = await callGateway(apiKey, FIX_SYSTEM, user, 0.2);
    const parsed = extractJson<{ home: string; away: string }[] | { fixtures?: { home: string; away: string }[] }>(content);
    const list = Array.isArray(parsed) ? parsed : parsed?.fixtures;
    if (!Array.isArray(list)) throw new Error("AI returned an unreadable week");
    const teamSet = new Set(data.teams);
    const fixtures = list
      .filter((m) => m && teamSet.has(m.home) && teamSet.has(m.away) && m.home !== m.away)
      .map((m) => ({ home: m.home, away: m.away }));
    if (fixtures.length === 0) throw new Error("AI returned no valid matches");
    return { fixtures };
  });
