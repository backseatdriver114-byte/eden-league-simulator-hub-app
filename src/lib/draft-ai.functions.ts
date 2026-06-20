import { createServerFn } from "@tanstack/react-start";

// Draft AI helpers — Lovable AI generates a prospect's individual attribute
// spread from their name + position + chosen overall, and picks the best
// prospect for an AI-owned draft pick. The model only PROPOSES values/choices;
// the client clamps/validates and re-computes the overall rating.

import { chatCompletion } from "./ai-fallback.server";

function extractJson<T>(content: string): T | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1)) as T;
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
    temperature: 0.85,
    structured: true,
  });
  return content;
}


// The 15 individual attributes (rating/OVR is derived, not requested).
export interface ProspectAttributes {
  FIN: number; SHO: number; PAS: number; VIS: number; DRI: number;
  PAC: number; STA: number; DEF: number; TAC: number; POS_attr: number;
  COM: number; WR: number; AGG: number; STR: number; AER: number;
}

interface RatingsInput {
  name: string;
  position: string;
  overall: number;
}

const RATINGS_RULES = `
You generate the individual soccer attribute spread for a fictional Eden League draft prospect.

You are given the prospect's NAME, POSITION, and target OVERALL rating (a 1-10 scale, one decimal).
Produce the 15 individual attributes, each on the SAME 1-10 scale (one decimal allowed):
FIN (finishing), SHO (shooting), PAS (passing), VIS (vision), DRI (dribbling), PAC (pace/speed),
STA (stamina), DEF (defending), TAC (tackling), POS_attr (positioning), COM (composure),
WR (work rate), AGG (aggression), STR (strength), AER (aerial/heading).

RULES:
- The attributes should AVERAGE OUT roughly to the target overall, so a higher overall means generally higher numbers. Keep all values within 1.0–10.0.
- THEME the spread to the NAME and POSITION. The name is a strong flavor hint:
  • "Boulder" / "Tank" / "Wall" → boost STR, TAC, AER, DEF; cut PAC, DRI.
  • "Einstein" / "Professor" → boost COM, VIS, POS_attr, PAS; cut STR, PAC.
  • "Noodle" / "Twig" → cut STR, AER, AGG; maybe boost DRI, PAC.
  • "Rocket" / "Flash" / "Bolt" → boost PAC, STA; .
  • "Sniper" / "Gunner" → boost FIN, SHO.
  Use sensible judgement for any name; if the name has no obvious theme, give a balanced spread for the position.
- Also respect the POSITION (e.g. a GK leans on COM/POS/AER; a striker on FIN/SHO/PAC; a CB on DEF/TAC/STR/AER).
- Make the standout themed traits clearly higher than the weak ones, but keep the overall average near the target.

OUTPUT FORMAT:
- Respond with ONE JSON object with exactly these keys: FIN, SHO, PAS, VIS, DRI, PAC, STA, DEF, TAC, POS_attr, COM, WR, AGG, STR, AER. Numbers only. No markdown, no extra text.
`;

export const generateProspectRatings = createServerFn({ method: "POST" })
  .inputValidator((data: RatingsInput) => {
    if (!data || typeof data.name !== "string" || data.name.trim().length === 0) throw new Error("Missing name");
    if (typeof data.position !== "string" || data.position.trim().length === 0) throw new Error("Missing position");
    if (typeof data.overall !== "number" || !Number.isFinite(data.overall)) throw new Error("Missing overall");
    return data;
  })
  .handler(async ({ data }): Promise<{ attributes: ProspectAttributes }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const user = [
      `PROSPECT NAME: ${data.name}`,
      `POSITION: ${data.position}`,
      `TARGET OVERALL: ${data.overall.toFixed(1)} (on the 1-10 scale)`,
      ``,
      `Generate the themed attribute spread. JSON object only.`,
    ].join("\n");

    const content = await callGateway(apiKey, RATINGS_RULES, user);
    const parsed = extractJson<Record<string, unknown>>(content) ?? {};
    const keys: (keyof ProspectAttributes)[] = [
      "FIN", "SHO", "PAS", "VIS", "DRI", "PAC", "STA", "DEF", "TAC", "POS_attr", "COM", "WR", "AGG", "STR", "AER",
    ];
    const clamp = (n: unknown) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return data.overall;
      return Math.max(1, Math.min(10, Math.round(v * 10) / 10));
    };
    const attributes = {} as ProspectAttributes;
    for (const k of keys) attributes[k] = clamp(parsed[k]);
    return { attributes };
  });

interface PickInput {
  team: string;
  brief: string; // available prospects + the team's roster/needs
  prospectNames: string[]; // the legal pool to choose from
}

const PICK_RULES = `
You are a club's scouting director making a draft selection in the fictional Eden League.

Using ONLY the DATA block (the available prospects and your club's current roster/needs), choose the SINGLE best prospect to draft for your club. Balance:
- raw quality (overall rating), and
- positional need (fill weak/thin spots on your roster rather than stacking a strong position).

OUTPUT FORMAT:
- Respond with ONE JSON object: {"pick": "<exact prospect name from the list>"}
- The name MUST be copied exactly from the available prospects. No markdown, no extra text.
`;

export const aiDraftPick = createServerFn({ method: "POST" })
  .inputValidator((data: PickInput) => {
    if (!data || typeof data.brief !== "string" || data.brief.trim().length === 0) throw new Error("Missing brief");
    if (!Array.isArray(data.prospectNames) || data.prospectNames.length === 0) throw new Error("No prospects");
    return data;
  })
  .handler(async ({ data }): Promise<{ pick: string }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const user = [
      `YOUR CLUB: ${data.team}`,
      ``,
      `DATA (the only facts you may use):`,
      data.brief,
      ``,
      `AVAILABLE PROSPECTS (choose exactly one by name): ${data.prospectNames.join(", ")}`,
      ``,
      `Make your selection. JSON only.`,
    ].join("\n");

    const content = await callGateway(apiKey, PICK_RULES, user);
    const parsed = extractJson<{ pick?: string }>(content);
    const pick = parsed?.pick?.trim();
    // Validate against the legal pool; fall back to the highest available if the
    // model returned something off-list.
    if (pick && data.prospectNames.includes(pick)) return { pick };
    return { pick: data.prospectNames[0] };
  });
