import { createServerFn } from "@tanstack/react-start";

// Agent Negotiation — AI-powered contract talks with a player's agent.
// Mirrors the manager-negotiation flow but at the PLAYER level, used by
// user-controlled clubs from the Contracts suite. The server function only
// generates dialogue + accept/cancel signals; the client writes the resulting
// contract terms via signNewContract().

export interface AgentProfile {
  name: string;
  personality: string; // free-text demeanor
  tolerance: string;   // explicit tolerance phrase (e.g. "Low trading tolerance; ...")
}

export interface ContractOffer {
  salaryM: number;   // proposed annual salary in $M
  years: number;     // proposed contract length in years
}

export interface AgentTurn { role: "user" | "agent"; text: string; }

interface NegotiateAgentInput {
  team: string;
  playerName: string;
  playerSummary: string;   // factual brief the client builds
  agent: AgentProfile;
  offer: ContractOffer;
  history: AgentTurn[];
  userMessage: string;
}

interface GenerateAgentInput {
  playerName: string;
  playerSummary?: string;
  takenNames?: string[];
}

import { chatCompletion } from "./ai-fallback.server";

function extractJson<T>(content: string): T | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(content.slice(start, end + 1)) as T; } catch { return null; }
}

async function callGateway(_apiKey: string, system: string, user: string, temperature = 0.9) {
  const { content } = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
    structured: true,
  });
  return content;
}


const AGENT_RULES = `
You are a player's agent negotiating a NEW contract with the player's own club (the USER). Stay fully in character.

ABSOLUTE RULES:
- Use ONLY the facts in the DATA block (the player's stats, age, current salary/years, market value, club, morale). Never invent ratings, salaries, market values, or league events.
- The deal is about TWO numbers: the annual SALARY (in $M) and the CONTRACT LENGTH (years).
- "accepts" is true ONLY if you are genuinely willing to sign the deal exactly as described in the CURRENT OFFER. If you'd prefer different terms, accepts is false and your reply should make the counter clear.

TRADING TOLERANCE (most important rule — overrides any extreme wording in your personality):
- You range from somewhat-stubborn to somewhat-generous. Judge each offer against the player's market value (use it as the fair benchmark):
  • A fair offer (roughly the player's market value, with a sensible length) should EVENTUALLY be accepted — a stubborn agent may haggle once or twice first.
  • A clearly insulting lowball (well below market value) should be rejected with a counter — never accept it just because you are "easy-going".
- Phrases like "impossible", "never signs", "demands the world" are FLAVOR for tone only, not your actual acceptance threshold.

WALKING AWAY:
- You may end the negotiation with a firm refusal by setting "cancels": true. Do this only when the user is wasting your time (insulting lowballs, repeating the same offer, demanding terms no agent would accept). Do not cancel on a reasonable first offer.

TONE:
- Vivid, human, in-character. Keep replies tight (1-3 short paragraphs). No bullet lists, no stat dumps.

OUTPUT FORMAT:
- Respond with a single JSON object: {"reply": "<your in-character message>", "accepts": <true|false>, "cancels": <true|false>}
- "accepts" and "cancels" are mutually exclusive — never both true.
- No markdown, no extra text outside the JSON.
`;

export const negotiateAgent = createServerFn({ method: "POST" })
  .inputValidator((data: NegotiateAgentInput) => {
    if (!data || typeof data.playerSummary !== "string" || data.playerSummary.trim().length === 0) {
      throw new Error("Missing player summary");
    }
    if (!data.agent || typeof data.agent !== "object") throw new Error("Missing agent");
    if (!data.offer || typeof data.offer !== "object") throw new Error("Missing offer");
    if (typeof data.userMessage !== "string" || data.userMessage.trim().length === 0) {
      throw new Error("Empty message");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const system =
      `You are ${data.agent.name}, the agent representing ${data.playerName} (currently on ${data.team}).\n` +
      `YOUR PERSONALITY: ${data.agent.personality}\n` +
      `YOUR TOLERANCE: ${data.agent.tolerance}\n` +
      AGENT_RULES;

    const historyText = data.history.length
      ? data.history
          .map((h) => `${h.role === "user" ? "CLUB GM (the user)" : "YOU"}: ${h.text}`)
          .join("\n")
      : "(no prior messages — this is the opening of the negotiation)";

    const user = [
      `DATA (the only facts you may use):`,
      ``,
      data.playerSummary,
      ``,
      `CURRENT OFFER ON THE TABLE: ${data.offer.years}-year deal at $${data.offer.salaryM}M per year.`,
      ``,
      `CONVERSATION SO FAR:`,
      historyText,
      ``,
      `CLUB GM'S LATEST MESSAGE: ${data.userMessage}`,
      ``,
      `Reply now as ${data.agent.name}, in JSON only.`,
    ].join("\n");

    const content = await callGateway(apiKey, system, user);
    const parsed = extractJson<{ reply?: string; accepts?: unknown; cancels?: unknown }>(content);
    let reply = parsed && typeof parsed.reply === "string" ? parsed.reply : content;
    const truthy = (v: unknown) => v === true || v === "true" || v === 1;
    const cancels = truthy(parsed?.cancels);
    const accepts = !cancels && truthy(parsed?.accepts);
    if (!reply.trim()) reply = "…";
    return { reply: reply.trim(), accepts, cancels };
  });

// ---------------- Agent identity generator ----------------
// Fixed pool of agent personalities + tolerance phrases. The client picks one
// at random per player so each agent feels distinct without a network round-trip
// just to invent a personality. The AI can still NAME the agent if asked.

export const AGENT_PERSONALITIES: { personality: string; tolerance: string }[] = [
  {
    personality: "Smooth-talking and patient. Always polite, never raises their voice, but rarely budges from their first number.",
    tolerance: "Medium tolerance; eventually accepts a fair-market offer after a round of polite haggling.",
  },
  {
    personality: "Loud, theatrical, and quick to take offense. Treats every negotiation like a stage performance.",
    tolerance: "High tolerance; insists on slight overpay before signing.",
  },
  {
    personality: "Ice-cold, all-business, speaks in clipped sentences and quotes market value verbatim.",
    tolerance: "Low tolerance; signs market-value deals quickly, walks immediately on lowballs.",
  },
  {
    personality: "Friendly and chatty, always swapping family stories before getting down to numbers.",
    tolerance: "Very low tolerance; happy to take a small discount when the conversation is warm.",
  },
  {
    personality: "Hard-nosed old hand who has seen every trick in the book and isn't impressed by any of them.",
    tolerance: "High tolerance; demands a clear premium over market value to sign.",
  },
  {
    personality: "Ambitious and a bit cocky, always angling for a long-term mega-deal that locks the player in.",
    tolerance: "Medium tolerance; only signs longer-term contracts (3+ years).",
  },
  {
    personality: "Quietly anxious; constantly worried about the player's morale and reputation.",
    tolerance: "Low tolerance; signs fair offers if the club's pitch is respectful.",
  },
  {
    personality: "Bohemian and unpredictable; might quote a verse of poetry mid-negotiation. Decisions feel almost random.",
    tolerance: "Random tolerance; sometimes accepts strange deals, sometimes refuses perfectly fair ones.",
  },
  {
    personality: "A former player turned agent — speaks the GM's language, focused on legacy and the right fit.",
    tolerance: "Medium tolerance; values respect and reasonable length over squeezing the last dollar.",
  },
  {
    personality: "Brash and entitled. Treats the negotiation as an obvious formality — the player is doing the club a favor by listening.",
    tolerance: "Very high tolerance; requires significant overpay AND long-term security.",
  },
];

const AGENT_FIRST_NAMES = [
  "Marco", "Elena", "Jorge", "Aiko", "Rashid", "Petra", "Tomás", "Yuna",
  "Sven", "Olive", "Naveen", "Lior", "Cassia", "Diego", "Mira", "Bex",
  "Ola", "Kenji", "Halima", "Ruairi",
];
const AGENT_LAST_NAMES = [
  "Hartmann", "Okafor", "Reyes", "Sokolova", "Bianchi", "Nakamura", "Larsen",
  "Bhatia", "Costa", "Vasquez", "Andersson", "Khoury", "Iverson", "Mensah",
  "Castillo", "Donnelly", "Fischer", "Saito", "Petrov", "Mwangi",
];

function pickAgentName(taken: Set<string>): string {
  for (let i = 0; i < 40; i++) {
    const name = `${AGENT_FIRST_NAMES[Math.floor(Math.random() * AGENT_FIRST_NAMES.length)]} ${AGENT_LAST_NAMES[Math.floor(Math.random() * AGENT_LAST_NAMES.length)]}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `${AGENT_FIRST_NAMES[0]} ${AGENT_LAST_NAMES[0]} ${Math.floor(Math.random() * 99)}`;
}

// Synchronous agent generator — no network call required. Picks a random
// personality from the pool and a non-colliding name. Exported so the
// Contracts suite can lazily attach an agent to a player on first open.
export function generateAgentLocally(takenNames: string[] = []): { name: string; personality: string; tolerance: string } {
  const taken = new Set(takenNames.map((n) => n.toLowerCase().trim()).filter(Boolean));
  const profile = AGENT_PERSONALITIES[Math.floor(Math.random() * AGENT_PERSONALITIES.length)];
  return {
    name: pickAgentName(taken),
    personality: profile.personality,
    tolerance: profile.tolerance,
  };
}

// Server-side variant kept for parity / future use (currently unused by the
// client since we generate locally to avoid a wasted round-trip).
export const generateAgent = createServerFn({ method: "POST" })
  .inputValidator((data: GenerateAgentInput) => {
    if (!data || typeof data.playerName !== "string") throw new Error("Missing player");
    return data;
  })
  .handler(async ({ data }) => generateAgentLocally(data.takenNames));
