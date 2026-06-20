// Private DM — user-controlled manager texting another manager or a player on
// their own roster. AI replies in character; tone is scored in the same call
// so morale/relations can be updated client-side without a second round trip.
import { createServerFn } from "@tanstack/react-start";

import { chatCompletion } from "./ai-fallback.server";

export type Counterpart = "manager" | "player" | "group";
export interface DmTurn { role: "user" | "ai" | "press"; text: string; }

interface DmInput {
  userTeam: string;          // user's club
  userManagerName: string;   // user's own manager name (if any)
  kind: Counterpart;
  counterpartTeam: string;   // for manager DMs = AI club; for player DMs = the user's own club
  counterpartName: string;   // the recipient (manager or player)
  counterpartPersonality?: string; // manager personality (DMs with managers only)
  brief: string;             // factual brief built on the client
  history: DmTurn[];
  userMessage: string;       // the user's latest message — empty when `initiate` is true
  initiate?: boolean;        // when true, the AI is opening the conversation unprompted
}

function extractJson<T>(s: string): T | null {
  const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as T; } catch { return null; }
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


const MANAGER_DM_RULES = `
You are an AI manager in the Eden League texting privately with another club's manager (the USER). Stay in character.

ABSOLUTE RULES:
- Use ONLY facts in the BRIEF. Never invent players, ratings, results, or money.
- Keep replies SHORT — 1-3 short sentences, conversational text-message tone.
- Your tolerance and behavior follow your PERSONALITY, tempered by how warm the relationship feels in this conversation.
- The user might be friendly, professional, prickly, or trying to bait you. Match the tone realistically — don't be a doormat AND don't be needlessly hostile.

OUTPUT FORMAT — JSON object exactly:
{"reply":"<your text message>","tone":<integer -3..3>,"userTone":<integer -3..3>}
- "tone": how friendly YOUR reply is (-3 = hostile, 0 = neutral, +3 = warm).
- "userTone": how friendly the USER's latest message was (your read of it).
No markdown, no extra text.
`;

const PLAYER_DM_RULES = `
You are a player on the user's own club, texting privately with your own manager (the USER). Stay in character: a young pro talking to your gaffer.

ABSOLUTE RULES:
- Use ONLY facts in the BRIEF. Never invent stats, contracts, transfers, or events.
- Keep replies SHORT — 1-3 short sentences, conversational text-message tone.
- React naturally to how the manager talks to you: praise lifts your mood; criticism, threats, or dismissal sting; balanced honesty is respected.

OUTPUT FORMAT — JSON object exactly:
{"reply":"<your text message>","tone":<integer -3..3>,"userTone":<integer -3..3>}
- "tone": how YOUR reply reads (-3 = upset / bitter, 0 = neutral, +3 = happy / motivated).
- "userTone": how the manager's latest message felt to you (-3 = harsh, +3 = supportive).
No markdown, no extra text.
`;

export const sendDm = createServerFn({ method: "POST" })
  .inputValidator((d: DmInput) => {
    if (!d) throw new Error("Empty payload");
    if (d.kind !== "manager" && d.kind !== "player") throw new Error("Invalid counterpart kind");
    if (!d.initiate && (typeof d.userMessage !== "string" || d.userMessage.trim().length === 0)) {
      throw new Error("Empty message");
    }
    return d;
  })
  .handler(async ({ data }): Promise<{ reply: string; tone: number; userTone: number }> => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("AI is not configured");
    const rules = data.kind === "manager" ? MANAGER_DM_RULES : PLAYER_DM_RULES;
    const persona = data.kind === "manager"
      ? `You are ${data.counterpartName}, manager of ${data.counterpartTeam}.\nYOUR PERSONALITY: ${data.counterpartPersonality ?? "Balanced, professional."}`
      : `You are ${data.counterpartName}, a player on ${data.counterpartTeam} (the user's own club).`;
    const userBlock = (data.userManagerName && data.userManagerName.toUpperCase() !== "USER CONTROLLED")
      ? `The user is ${data.userManagerName}, manager of ${data.userTeam}.`
      : `The user is the manager of ${data.userTeam}.`;
    const history = data.history.length
      ? data.history.map((h) => {
          if (h.role === "press") {
            return `--- PUBLIC PRESS QUOTE (the manager said this on the record; treat it as something you HEARD or READ, not a DM) ---\n${h.text}\n--- end press quote ---`;
          }
          return `${h.role === "user" ? "MANAGER" : "YOU"}: ${h.text}`;
        }).join("\n")
      : "(no prior messages — this is the start of the conversation)";
    const tail = data.initiate
      ? `THE MANAGER HAS NOT MESSAGED YOU. You're texting them first, unprompted, because something on your mind made you reach out (recent results, the relationship, your situation). Open the conversation in 1-2 short sentences. Set "userTone" to 0 (they haven't said anything yet). Reply in JSON only.`
      : `MANAGER'S LATEST MESSAGE: ${data.userMessage}\n\nReply now in JSON only.`;
    const user = [
      `BRIEF (only facts you may use):`,
      data.brief,
      ``,
      userBlock,
      ``,
      `CONVERSATION SO FAR:`,
      history,
      ``,
      tail,
    ].join("\n");
    const content = await callGateway(key, persona + "\n" + rules, user);
    const parsed = extractJson<{ reply?: unknown; tone?: unknown; userTone?: unknown }>(content);
    const reply = parsed && typeof parsed.reply === "string" ? parsed.reply.trim() : content.trim() || "…";
    const tone = clampInt(parsed?.tone, 3);
    const userTone = clampInt(parsed?.userTone, 3);
    return { reply, tone, userTone };
  });

function clampInt(v: unknown, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-max, Math.min(max, Math.round(n)));
}

// Team Channel broadcast — the user-controlled manager posts to their whole
// squad at once. Nobody replies; we only need a tone score so morale can be
// nudged. One short AI call returns just {tone}.
interface BroadcastInput {
  userTeam: string;
  userManagerName: string;
  brief: string;
  message: string;
}

const BROADCAST_RULES = `
You are an emotional-tone analyst reading a manager's locker-room broadcast to their entire squad.

TASK: Score how the squad will FEEL about this message on a -3..+3 integer scale:
 -3 = humiliating / threatening / morale-crushing
  0 = neutral / informational
 +3 = inspiring / unifying / morale-lifting

OUTPUT FORMAT — JSON object exactly:
{"tone":<integer -3..3>}
No markdown, no extra text.
`;

export const scoreBroadcast = createServerFn({ method: "POST" })
  .inputValidator((d: BroadcastInput) => {
    if (!d) throw new Error("Empty payload");
    if (typeof d.message !== "string" || d.message.trim().length === 0) throw new Error("Empty message");
    return d;
  })
  .handler(async ({ data }): Promise<{ tone: number }> => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("AI is not configured");
    const user = [
      `BRIEF (context only):`,
      data.brief,
      ``,
      `MANAGER (${data.userManagerName} of ${data.userTeam}) BROADCAST:`,
      data.message,
      ``,
      `Score the squad's reaction. Reply in JSON only.`,
    ].join("\n");
    const content = await callGateway(key, BROADCAST_RULES, user, 0.3);
    const parsed = extractJson<{ tone?: unknown }>(content);
    return { tone: clampInt(parsed?.tone, 3) };
  });
