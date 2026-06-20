import { createServerFn } from "@tanstack/react-start";

// Negotiation Suite — AI trade negotiation against personality-driven managers.
// Entertainment/strategy layer ONLY: the AI talks, it never mutates league
// state. The CLIENT assembles a factual brief (real rosters, ratings, values,
// budgets, cap) and the concrete on-the-table terms; this function narrates a
// reply in character and signals whether the manager accepts THOSE terms.
// The actual trade is executed client-side by the existing trade engine.

export interface NegotiationTerms {
  userTeam: string;
  aiTeam: string;
  userSends: string[]; // player names the user's club gives up
  aiSends: string[]; // player names the AI club gives up
  cashUserReceives: number; // $M paid by AI club to user club
  cashAiReceives: number; // $M paid by user club to AI club
  userPicks?: string[]; // draft pick labels the user club gives up
  aiPicks?: string[]; // draft pick labels the AI club gives up
}

export interface NegotiationTurn {
  role: "user" | "manager";
  text: string;
}

interface NegotiateInput {
  managerName: string;
  personality: string;
  userManagerName?: string; // the user's own manager name, if they've set one
  brief: string; // factual digest assembled on the client
  terms: NegotiationTerms;
  history: NegotiationTurn[];
  userMessage: string;
}

interface GenerateManagerInput {
  team: string;
  tacticalStyle?: string;
  // Names that must not be reused (every other manager's name + every player
  // name in the league). The model is told to avoid these AND substring
  // collisions on last names. Passed by the watcher at call time.
  takenNames?: string[];
}

import { chatCompletion } from "./ai-fallback.server";

function describeTerms(t: NegotiationTerms): string {
  const userSends =
    (t.userSends.length ? t.userSends.join(", ") : "no players") +
    (t.userPicks && t.userPicks.length ? ` + draft picks [${t.userPicks.join(", ")}]` : "") +
    (t.cashAiReceives > 0 ? ` + $${t.cashAiReceives}M cash` : "");
  const aiSends =
    (t.aiSends.length ? t.aiSends.join(", ") : "no players") +
    (t.aiPicks && t.aiPicks.length ? ` + draft picks [${t.aiPicks.join(", ")}]` : "") +
    (t.cashUserReceives > 0 ? ` + $${t.cashUserReceives}M cash` : "");
  return [
    `CURRENT PROPOSED TERMS (the deal on the table right now):`,
    `  - ${t.userTeam} (the user) GIVES: ${userSends}`,
    `  - ${t.aiTeam} (you) GIVE: ${aiSends}`,
  ].join("\n");
}

// Tolerant JSON extraction: models sometimes wrap JSON in prose or code fences.
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
    temperature: 0.9,
    structured: true,
  });
  return content;
}


const NEGOTIATION_RULES = `
Eden League is a fictional 24-team 9v9 soccer league. You are an AI club manager negotiating a trade with another club's manager (the user). Stay fully in character at all times.

ABSOLUTE RULES:
- Use ONLY the facts in the DATA block (rosters, ratings, player values, budgets, salary cap). Never invent players, stats, ratings, money, or league events not present in the DATA.
- Player ratings and values are real; higher is better. Cash figures are in $M.
- You may propose counter-offers IN WORDS, but you cannot change league state — only the user clicks the final button. Negotiate over the players and cash listed in the DATA.
- "accepts" must be true ONLY if you are genuinely willing to complete the deal exactly as described in the CURRENT PROPOSED TERMS. If you want changes, accepts is false and your reply should say what you want instead.

TRADING TOLERANCE (the most important rule — overrides any extreme wording in your personality):
- Every manager in this league is a REAL negotiator who CAN be traded with. Your personality only changes HOW HARD you haggle and HOW you talk — it never makes you an automatic "yes" or an automatic "no".
- Tolerance only ranges from somewhat-stubborn to somewhat-generous. Judge each offer on rough value fairness (compare combined player values + cash on each side):
  • A genuinely FAIR deal (roughly equal value, or one that fills a real need for you) should EVENTUALLY be accepted — a stubborn manager may haggle for a turn or two first, a generous one accepts quickly. Never flatly refuse a fair deal forever.
  • A CLEARLY LOPSIDED deal against you (you give up much more value than you receive) should be rejected with a counter — never accept an obviously bad deal just because you are "easy-going".
- If your personality says things like "accepts anything", "requires heavy overpay", "impossible", "never trades", "zero regard", treat those as FLAVOR for your tone only, NOT as your actual acceptance threshold.

WALKING AWAY (you may end the conversation):
- You are NOT forced to keep countering forever. If the user is insulting your club with a hopeless lowball, repeatedly re-sending essentially the same bad offer, clearly wasting your time, or asking for a player you would never part with, you may end the negotiation with a firm "no" by setting "cancels": true.
- Cancelling is a deliberate choice, not a default. Only walk away when continuing the talk is genuinely pointless. When you cancel, your reply should be a short, in-character closing line making clear the deal is dead. Do not cancel on a reasonable first offer — give fair deals a chance.

MOOD (human variance — keep it subtle):
- You have a current MOOD provided below. Let it gently color your tone and nudge your flexibility by a small amount this turn (a warm mood is a touch more giving; an impatient or hard-nosed mood haggles a little harder). Mood is a small wobble on top of your personality — your core character must still clearly shine through. Do NOT announce or name your mood.

TONE:
- Vivid, human, in-character. Use your personality's voice, quirks, and attitude.
- Keep replies tight: 1-3 short paragraphs of conversational dialogue. No bullet lists, no stat dumps.

OUTPUT FORMAT:
- Respond with a single JSON object: {"reply": "<your in-character message>", "accepts": <true|false>, "cancels": <true|false>}
- "accepts" and "cancels" are mutually exclusive — never both true.
- No markdown, no extra text outside the JSON.
`;

// A small set of transient moods that add human variance to each reply without
// overriding the manager's core personality.
const MOODS = [
  "upbeat and friendly today",
  "a little impatient and short on time",
  "distracted and only half-focused on this deal",
  "hard-nosed and in no mood to be pushed around",
  "warm, chatty, and in a generous frame of mind",
  "cautious and second-guessing everything",
  "confident and feeling like they hold all the cards",
  "tired and just wanting to wrap things up",
];

export const negotiateTrade = createServerFn({ method: "POST" })
  .inputValidator((data: NegotiateInput) => {
    if (!data || typeof data.brief !== "string" || data.brief.trim().length === 0) {
      throw new Error("Missing trade brief");
    }
    if (typeof data.userMessage !== "string" || data.userMessage.trim().length === 0) {
      throw new Error("Empty message");
    }
    if (!data.terms || typeof data.terms !== "object") throw new Error("Missing terms");
    return data;
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const counterpart =
      data.userManagerName && data.userManagerName.trim() &&
      data.userManagerName.trim().toUpperCase() !== "USER CONTROLLED"
        ? data.userManagerName.trim()
        : null;

    const mood = MOODS[Math.floor(Math.random() * MOODS.length)];
    const system =
      `You are ${data.managerName}, manager of ${data.terms.aiTeam} in the Eden League.\n` +
      `YOUR PERSONALITY: ${data.personality}\n` +
      `YOUR CURRENT MOOD (subtle, do not announce): ${mood}\n` +
      (counterpart
        ? `You are negotiating with ${counterpart}, the manager of ${data.terms.userTeam}. Address them by name (${counterpart}) in your replies.\n`
        : "") +
      NEGOTIATION_RULES;

    const historyText = data.history.length
      ? data.history
          .map((h) => `${h.role === "user" ? "USER MANAGER" : "YOU"}: ${h.text}`)
          .join("\n")
      : "(no prior messages — this is the opening of the negotiation)";

    const user = [
      `DATA (the only facts you may use):`,
      ``,
      data.brief,
      ``,
      describeTerms(data.terms),
      ``,
      `CONVERSATION SO FAR:`,
      historyText,
      ``,
      `USER MANAGER'S LATEST MESSAGE: ${data.userMessage}`,
      ``,
      `Reply now as ${data.managerName}, in JSON only.`,
    ].join("\n");

    const content = await callGateway(apiKey, system, user);
    const parsed = extractJson<{ reply?: string; accepts?: unknown; cancels?: unknown }>(content);
    let reply = parsed && typeof parsed.reply === "string" ? parsed.reply : content;
    // Tolerate the model returning a stringy/numeric truthy value for accepts/cancels.
    const truthy = (v: unknown) => v === true || v === "true" || v === 1;
    const cancels = truthy(parsed?.cancels);
    const accepts = !cancels && truthy(parsed?.accepts);
    if (!reply.trim()) reply = "…";
    return { reply: reply.trim(), accepts, cancels };
  });

// Banned substrings: the model has a strong tendency to reuse certain names
// across calls (notably "Vane"). Block them outright.
const BANNED_NAME_SUBSTRINGS = ["vane"];

// Food-themed fallback name pool — keeps with the league's existing flavor
// (Brockoli, Thomas Tomato, Paviar...) when the model fails or duplicates.
const FOOD_FIRST_NAMES = [
  "Marco", "Luca", "Olive", "Saffron", "Hugo", "Pesto", "Basil", "Clove",
  "Mango", "Pico", "Reggie", "Tofu", "Wasabi", "Cobb", "Risotto", "Halloumi",
  "Pretzel", "Sorbet", "Cassava", "Quince", "Yuzu", "Falafel",
];
const FOOD_LAST_NAMES = [
  "Saffron", "Pesto", "Mostarda", "Capers", "Bramble", "Walnut", "Habanero",
  "Marrow", "Truffle", "Brisket", "Linguine", "Polenta", "Almondine",
  "Tahini", "Paprika", "Cardamom", "Galette", "Pavlova", "Ponzu",
];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function fallbackManager(taken: Set<string>): { name: string; personality: string } {
  for (let i = 0; i < 30; i++) {
    const name = `${pick(FOOD_FIRST_NAMES)} ${pick(FOOD_LAST_NAMES)}`;
    if (!taken.has(name.toLowerCase()) && !BANNED_NAME_SUBSTRINGS.some((b) => name.toLowerCase().includes(b))) {
      return {
        name,
        personality:
          "A freshly appointed manager finding their feet. Balanced trading tolerance; open to fair, sensible deals.",
      };
    }
  }
  // Last-resort uniqueness guarantee.
  return {
    name: `${pick(FOOD_FIRST_NAMES)} ${pick(FOOD_LAST_NAMES)} ${Math.floor(Math.random() * 99) + 1}`,
    personality:
      "A freshly appointed manager finding their feet. Balanced trading tolerance; open to fair, sensible deals.",
  };
}

function nameIsAcceptable(name: string, taken: Set<string>): boolean {
  const lower = name.toLowerCase();
  if (!lower.trim()) return false;
  if (BANNED_NAME_SUBSTRINGS.some((b) => lower.includes(b))) return false;
  if (taken.has(lower)) return false;
  // Reject a last-name collision too (e.g. "Mike Vane" -> taken last name "Vane").
  const parts = lower.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (last && taken.has(last)) return false;
  return true;
}

const NEW_MANAGER_RULES = `
Eden League is a fictional 24-team 9v9 soccer league. Invent a brand-new club manager who has just been appointed after the previous one was sacked.

RULES (FOLLOW STRICTLY):
- Create ONE fresh, original manager: a short characterful name AND a distinctive negotiating personality.
- The name MUST be unique across the league. You will be given a list of forbidden names — never reuse any of them, never reuse a forbidden LAST name, and never use the substring "Vane" (case-insensitive) anywhere in the name.
- Vary cultural origin and style across appointments — do not gravitate to the same name patterns over and over. League flavor often borrows food/culinary words (e.g. Brockoli, Thomas Tomato, Paviar) — that vibe is welcome but not required.
- The personality should read like the league's existing GM profiles: one-to-three vivid sentences of demeanor PLUS an explicit trading tolerance (e.g. "High trading tolerance; requires heavy overpay.").

OUTPUT FORMAT:
- Respond with a single JSON object: {"name": "<manager name>", "personality": "<description + trading tolerance>"}
- No markdown, no extra text outside the JSON.
`;

export const generateManager = createServerFn({ method: "POST" })
  .inputValidator((data: GenerateManagerInput) => {
    if (!data || typeof data.team !== "string" || data.team.trim().length === 0) {
      throw new Error("Missing team");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const taken = new Set(
      (data.takenNames ?? []).map((n) => n.toLowerCase().trim()).filter(Boolean)
    );
    // Also seed last-name collisions into the taken set.
    for (const full of data.takenNames ?? []) {
      const parts = full.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) taken.add(last);
    }

    const forbiddenList = (data.takenNames ?? []).slice(0, 80).join(", ") || "(none yet)";
    const baseUser =
      `Appoint a new manager for the club "${data.team}"` +
      (data.tacticalStyle ? ` (they currently play a "${data.tacticalStyle}" style).` : ".") +
      `\n\nFORBIDDEN NAMES — do NOT use any of these, do NOT reuse a forbidden LAST name, do NOT include the substring "Vane" anywhere: ${forbiddenList}.\n` +
      `Return JSON only.`;

    // Up to two attempts so a single bad model response (collision/Vane) doesn't
    // force the deterministic fallback prematurely.
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = await callGateway(
        apiKey,
        "You are a creative sports-fiction writer.\n" + NEW_MANAGER_RULES,
        attempt === 0
          ? baseUser
          : baseUser + `\n\nYour previous attempt was rejected (it duplicated an existing name or contained a forbidden substring). Try a completely different cultural style this time.`,
      );
      const parsed = extractJson<{ name?: string; personality?: string }>(content);
      if (parsed) {
        const name = (parsed.name ?? "").trim();
        const personality = (parsed.personality ?? "").trim();
        if (name && personality && nameIsAcceptable(name, taken)) {
          return { name, personality };
        }
      }
    }
    return fallbackManager(taken);
  });
