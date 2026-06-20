import { createServerFn } from "@tanstack/react-start";

// AI trade engine — Lovable AI generates realistic trade proposals across the
// whole league market. The model only PROPOSES; the client re-validates every
// returned deal against the existing safety guards (roster legality, salary
// cap, affordability, fieldability) before any proposal is surfaced.

export interface AiProposedTerm {
  teamA: string;
  teamB: string;
  aSends: string; // player name teamA gives to teamB ("" if none)
  bSends: string; // player name teamB gives to teamA ("" if none)
  cashAReceives: number; // $M paid by B to A
  cashBReceives: number; // $M paid by A to B
  aPicks?: string[]; // draft pick labels teamA gives to teamB
  bPicks?: string[]; // draft pick labels teamB gives to teamA
}

interface GenerateInput {
  brief: string; // full-league factual digest assembled on the client
  count?: number; // desired number of proposals
  allowPicks?: boolean; // permit draft picks as assets in proposals
}

import { chatCompletion } from "./ai-fallback.server";

function extractJsonArray<T>(content: string): T[] | null {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

async function callGateway(_apiKey: string, system: string, user: string) {
  const { content } = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.95,
    structured: true,
  });
  return content;
}


const TRADE_RULES = `
Eden League is a fictional 24-team 9v9 soccer league. You are the league's trade market engine. Using ONLY the DATA block, propose a set of realistic, mutually-beneficial one-for-one player trades between clubs.

ABSOLUTE RULES:
- Use ONLY clubs and players that appear in the DATA. Never invent players, ratings, values, or clubs.
- Each proposal swaps exactly ONE player from club A for ONE player from club B, optionally with cash to bridge a value gap.
- Cash is in $M and must be affordable from the paying club's transfer budget. The richer-value side receives cash; if values are equal, cash is 0.
- A deal must make sense for BOTH clubs: address a positional need, upgrade a weak spot, cash in on a surplus, or get fair value. Avoid lopsided robberies.
- Never propose a deal that would leave a club unable to field a team or that pushes a club over the salary cap (salaries travel with the player).
- Draw on the FULL league picture: relative team strength, positional depth, ages, contract situations, and budgets.

OUTPUT FORMAT:
- Respond with ONLY a JSON array of proposal objects, no prose, no markdown:
[{"teamA":"<club>","teamB":"<club>","aSends":"<player on teamA>","bSends":"<player on teamB>","cashAReceives":<number>,"cashBReceives":<number>}]
- cashAReceives is $M teamB pays teamA; cashBReceives is $M teamA pays teamB. At most one is greater than 0.
`;

// Draft-time variant: picks may be packaged as assets alongside (or instead of)
// players. Used during the Eden League Draft.
const TRADE_RULES_PICKS = `
Eden League is a fictional 24-team 9v9 soccer league in its OFFSEASON DRAFT. You are the league's trade market engine. Using ONLY the DATA block, propose a small set of the very best, most realistic trades between clubs. Quality over quantity — only surface genuinely smart, mutually-beneficial deals. If nothing good exists, return an empty array.

ABSOLUTE RULES:
- Use ONLY clubs, players, and draft picks that appear in the DATA. Never invent anything.
- Each proposal is between exactly TWO clubs. Each side may send a player and/or one or more draft picks, optionally with cash. A side may send only picks (then its player field is "").
- Draft picks are listed per club as labels like "S2 R1 (Socks)". Use those EXACT labels. A club can only trade picks it currently owns.
- Cash is in $M and must be affordable from the paying club's transfer budget.
- Deals must make sense for BOTH clubs (fill a need, acquire draft capital, cash in on surplus, get fair value). Avoid lopsided robberies and roster-breaking deals (never leave a club unable to field a team or over the salary cap).
- Draft picks are especially valuable to budget-strapped clubs (rookies sign cheap $2M/2yr deals).

OUTPUT FORMAT:
- Respond with ONLY a JSON array (possibly empty), no prose, no markdown:
[{"teamA":"<club>","teamB":"<club>","aSends":"<player on teamA or empty>","bSends":"<player on teamB or empty>","aPicks":["<pick label>"],"bPicks":["<pick label>"],"cashAReceives":<number>,"cashBReceives":<number>}]
- aPicks/bPicks may be empty arrays. cashAReceives is $M teamB pays teamA; cashBReceives is $M teamA pays teamB. At most one cash value is greater than 0.
`;

export const generateAiTradeProposals = createServerFn({ method: "POST" })
  .inputValidator((data: GenerateInput) => {
    if (!data || typeof data.brief !== "string" || data.brief.trim().length === 0) {
      throw new Error("Missing trade market brief");
    }
    return data;
  })
  .handler(async ({ data }): Promise<{ proposals: AiProposedTerm[] }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const count = Math.min(Math.max(data.count ?? 12, 4), 25);
    const rules = data.allowPicks ? TRADE_RULES_PICKS : TRADE_RULES;
    const user = [
      `DATA (the only facts you may use):`,
      ``,
      data.brief,
      ``,
      `Propose up to ${count} of the best, most realistic trades right now. JSON array only.`,
    ].join("\n");

    const content = await callGateway(apiKey, rules, user);
    const raw = extractJsonArray<Record<string, unknown>>(content) ?? [];

    const asLabels = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

    const proposals: AiProposedTerm[] = [];
    for (const r of raw) {
      const teamA = typeof r.teamA === "string" ? r.teamA : "";
      const teamB = typeof r.teamB === "string" ? r.teamB : "";
      const aSends = typeof r.aSends === "string" ? r.aSends : "";
      const bSends = typeof r.bSends === "string" ? r.bSends : "";
      const aPicks = asLabels(r.aPicks);
      const bPicks = asLabels(r.bPicks);
      if (!teamA || !teamB) continue;
      // A valid deal must move at least one asset on at least one side.
      const hasAsset = aSends || bSends || aPicks.length || bPicks.length ||
        Number(r.cashAReceives) > 0 || Number(r.cashBReceives) > 0;
      if (!hasAsset) continue;
      proposals.push({
        teamA,
        teamB,
        aSends,
        bSends,
        aPicks,
        bPicks,
        cashAReceives: Number(r.cashAReceives) || 0,
        cashBReceives: Number(r.cashBReceives) || 0,
      });
    }
    return { proposals };
  });
