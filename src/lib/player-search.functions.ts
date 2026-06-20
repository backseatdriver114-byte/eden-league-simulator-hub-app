import { createServerFn } from "@tanstack/react-start";

// Natural-language player search. Translates a plain-English request like
// "fast wingers who also have great stamina" into the structured search grammar
// used by parseSearchQuery (e.g. "WINGER PAC > 8 STA > 8"). The CLIENT then
// feeds that string back through the existing parser/matcher so results render
// identically to a hand-typed query. This function never touches league state.

import { chatCompletion } from "./ai-fallback.server";



interface InterpretInput {
  query: string;
}

const ATTR_CODES = [
  "OVR (overall rating)", "FIN (finishing)", "SHO (shooting)", "PAS (passing)",
  "VIS (vision)", "DRI (dribbling)", "PAC (pace/speed)", "STA (stamina)",
  "DEF (defending)", "TAC (tackling)", "POS (positioning)", "COM (composure)",
  "WR (work rate)", "AGG (aggression)", "STR (strength)", "AER (aerial/heading)",
  "AGE (years old)", "SALARY (annual wage in $M)", "CONTRACT (years remaining)",
  "MORALE (0-100)",
];

const POSITIONS = "GK, ST, LW, RW, CAM, CM, CDM, LM, RM, CB, LB, RB, LWB, RWB";
const POSITION_GROUPS = "WINGER (any LW/RW), FULLBACK (any LB/RB/LWB/RWB), WINGBACK (LWB/RWB), MIDFIELDER (any midfield position), DEFENDER (any back), ATTACKER (any forward), CENTREBACK (CB), STRIKER (ST)";
const STATUS_FILTERS = "INJURED, SUSPENDED, HEALTHY, FOR SALE, STARTER, EXPIRING (1 year or less on contract)";

const SYSTEM = `You translate a soccer scout's plain-English player request into a compact structured search query for the Eden League player database.

ALL ATTRIBUTES are on a 1.0–10.0 scale (higher is better). Available attribute codes:
${ATTR_CODES.join(", ")}.

Available positions: ${POSITIONS}.
Position GROUPS (preferred when the user is vague — they match ANY position in the group): ${POSITION_GROUPS}.
Boolean / categorical filters: ${STATUS_FILTERS}.

GRAMMAR you must output (space-separated tokens, nothing else):
- An optional position OR group token (use a single code or a group word like WINGER / FULLBACK).
- Zero or more comparison tokens of the form CODE OP NUMBER, where OP is one of > >= < <= = and NUMBER is on the 1–10 scale (except AGE in years, SALARY in $M, CONTRACT in years, MORALE in 0-100).
- Zero or more bare status tokens from the categorical filter list (INJURED, SUSPENDED, HEALTHY, "FOR SALE", STARTER, EXPIRING).
- Optional bare name substrings if the user clearly names a player.

INTERPRETATION GUIDE (map vague words to numeric thresholds on the 1–10 scale unless otherwise noted):
- "fast / quick / pacey" -> PAC > 8 ; "very fast / blistering" -> PAC > 8.5
- "great / elite / excellent <attr>" -> that attr > 8.5 ; "good <attr>" -> that attr > 7.5
- "high stamina / tireless" -> STA > 8 ; "strong / powerful" -> STR > 8
- "clinical / great finisher" -> FIN > 8.5 ; "creative / great passer" -> PAS > 8 or VIS > 8
- "young" -> AGE < 23 ; "veteran / experienced / old" -> AGE > 30 ; "cheap" -> SALARY < 5
- "high morale / happy / motivated" -> MORALE > 65 ; "unhappy / low morale" -> MORALE < 40
- "wingers" (any side) -> WINGER ; "outside backs / fullbacks" -> FULLBACK ; "midfielders" -> MIDFIELDER
- "injured" -> INJURED ; "available for transfer / listed / on the market" -> "FOR SALE"
- "last year of contract / contract running out / expiring" -> EXPIRING
- Combine multiple traits with multiple tokens (they are ANDed).

EXAMPLES:
- "fast wingers who also have great stamina" -> WINGER PAC > 8 STA > 8.5
- "players with high morale" -> MORALE > 65
- "a right wing on the last year of his contract" -> RW EXPIRING
- "young cheap defenders with good tackling" -> DEFENDER AGE < 23 SALARY < 5 TAC > 7.5
- "fullbacks who are listed for sale" -> FULLBACK FOR SALE
- "anyone injured on Cocos" -> INJURED cocos

OUTPUT FORMAT:
- Respond with a single JSON object: {"query": "<structured query string>"}
- No markdown, no commentary outside the JSON.`;

function extractJson<T>(content: string): T | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(content.slice(start, end + 1)) as T; } catch { return null; }
}

export const interpretSearch = createServerFn({ method: "POST" })
  .inputValidator((data: InterpretInput) => {
    if (!data || typeof data.query !== "string" || data.query.trim().length === 0) {
      throw new Error("Empty query");
    }
    return { query: data.query.trim().slice(0, 300) };
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const { content } = await chatCompletion({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Translate this request: "${data.query}". Return JSON only.` },
      ],
      temperature: 0.2,
      structured: true,
    });
    const parsed = extractJson<{ query?: string }>(content);
    const structured = parsed && typeof parsed.query === "string" ? parsed.query.trim() : "";
    if (!structured) throw new Error("Couldn't interpret that search");
    return { query: structured };
  });

