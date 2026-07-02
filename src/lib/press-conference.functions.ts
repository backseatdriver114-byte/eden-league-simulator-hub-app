// Press Conference — AI-powered, season-aware press questions and answer
// scoring. Mirrors the negotiation server-fn pattern. The CLIENT assembles a
// factual brief (standings, recent results, manager, key players) and submits
// a free-text answer; the model returns targeted morale/relation deltas the
// state layer then applies.
import { createServerFn } from "@tanstack/react-start";

import { chatCompletion } from "./ai-fallback.server";

export type PressContext = "general" | "pre" | "post";

export interface PressTargetTeam {
  kind: "team";
  name: string;
  moraleDelta: number;
}
export interface PressTargetPlayer {
  kind: "player";
  team: string;
  name: string;
  moraleDelta: number;
}
export interface PressTargetManager {
  kind: "manager";
  team: string;
  relationDelta: number;
}
export type PressTarget = PressTargetTeam | PressTargetPlayer | PressTargetManager;

export interface PressScoreResult {
  targets: PressTarget[];
  respectDelta: number; // -3..+3
  harshness: number;    // 0..1
  summary: string;      // short headline-style summary
}

interface QuestionsInput {
  team: string;          // user-controlled team holding the conference
  managerName: string;   // user's own manager name (or "the gaffer")
  context: PressContext;
  brief: string;         // factual digest from the client
  count?: number;        // desired number of questions (3-5)
}

interface NextQuestionInput {
  team: string;
  managerName: string;
  context: PressContext;
  brief: string;
  priorExchanges: { question: string; answer: string }[];
  questionNumber: number;
  totalQuestions: number;
  // Optional user-supplied angle: things to touch on in the questions.
  focus?: string;
}

interface ScoreInput {
  team: string;
  managerName: string;
  context: PressContext;
  brief: string;
  question: string;
  answer: string;
  // The model needs the universe of valid target names to ground its scoring
  // (avoids inventing players/managers).
  validTeams: string[];
  validManagers: { team: string; name: string }[];
  // playerName -> team, so we don't have to ship the whole roster.
  validPlayers: { team: string; name: string }[];
}

interface RecapInput {
  team: string;
  managerName: string;
  context: PressContext;
  brief: string;
  exchanges: { question: string; answer: string }[];
}

function extractJson<T>(content: string): T | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(content.slice(start, end + 1)) as T; } catch { return null; }
}
function extractJsonArray<T>(content: string): T[] | null {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch { return null; }
}

// Two flavors: `structured` parses JSON (skips Groq); `prose` is free-text
// (the recap) — all four fallback providers participate.
async function callGateway(_apiKey: string, system: string, user: string, temperature = 0.9, structured = true) {
  const { content } = await chatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
    structured,
  });
  return content;
}


// ---------------- 1. Generate the question set ----------------
const QUESTIONS_RULES = `
You are the Eden League press corps preparing a short press conference. Generate sharp, specific reporter questions a manager would actually face — grounded ONLY in the DATA block (standings, recent results, key players, injuries, contracts, rivals). Vary the angle: form, tactics, a specific player, a rival, a fixture, dressing-room mood. Mix friendly and pointed questions.

ABSOLUTE RULES:
- Never invent stats, players, clubs, scores, or league events not present in the DATA.
- Each question is one or two sentences, ending with a question mark.
- Address the manager naturally (you may use their name).
- For PRE-MATCH context, lean into the upcoming opponent and matchups.
- For POST-MATCH context, lean into the result that just happened and what it means.
- For GENERAL context, range across the season.

OUTPUT FORMAT:
- Respond with ONLY a JSON array of strings, no prose, no markdown.
- Each string is one question. Produce the requested number of questions.
`;

export const generatePressQuestions = createServerFn({ method: "POST" })
  .inputValidator((data: QuestionsInput) => {
    if (!data || typeof data.brief !== "string" || data.brief.trim().length === 0) {
      throw new Error("Missing press brief");
    }
    return data;
  })
  .handler(async ({ data }): Promise<{ questions: string[] }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");
    const count = Math.min(Math.max(data.count ?? 4, 3), 5);
    const user = [
      `DATA (the only facts you may use):`,
      ``,
      data.brief,
      ``,
      `CONTEXT: ${data.context} press conference for ${data.team} (manager: ${data.managerName}).`,
      `Generate exactly ${count} reporter questions. JSON array only.`,
    ].join("\n");
    const content = await callGateway(apiKey, QUESTIONS_RULES, user, 0.95);
    const arr = extractJsonArray<string>(content) ?? [];
    const cleaned = arr
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim())
      .slice(0, count);
    if (cleaned.length === 0) {
      throw new Error("AI returned no usable questions");
    }
    return { questions: cleaned };
  });

// ---------------- 1b. Generate ONE follow-up question ----------------
// Streams the conference one question at a time so each new question can
// react to what the manager actually just said and so the press corps can
// avoid asking anything the manager has already addressed in this conference
// or in previous on-record press archives (which are included in the brief).
const NEXT_QUESTION_RULES = `
You are a single reporter at the Eden League press lectern. Ask ONE sharp, specific question for the manager, grounded ONLY in the DATA block (standings, recent results, key players, injuries, contracts, rivals, and the RECENT PRESS QUOTES archive included in the brief).

ABSOLUTE RULES:
- Never invent stats, players, clubs, scores, or league events not present in the DATA.
- Do NOT repeat or paraphrase any question already asked in this conference (see PRIOR EXCHANGES below). Do NOT re-ask topics the manager has already answered on-record in the RECENT PRESS QUOTES archive within the brief — if a player's contract, an injury, a tactical change, or a feud has been discussed recently, MOVE ON unless brand-new information warrants a follow-up.
- If the manager's previous answer in this conference contained a quotable claim, contradiction, taunt, or dodge, FOLLOW UP on it directly — quote or reference their exact words.
- Vary the angle across the conference: form, tactics, a specific player, a rival, the next fixture, dressing-room mood.
- One or two sentences, ending with a question mark. Address the manager naturally (you may use their name).
- For PRE-MATCH context, lean into the upcoming opponent. For POST-MATCH, the result that just happened. For GENERAL, range across the season.

OUTPUT FORMAT:
- Respond with ONLY a JSON object: {"question": "<the question>"}. No prose, no markdown.
`;

export const generateNextPressQuestion = createServerFn({ method: "POST" })
  .inputValidator((data: NextQuestionInput) => {
    if (!data || typeof data.brief !== "string" || data.brief.trim().length === 0) {
      throw new Error("Missing press brief");
    }
    return data;
  })
  .handler(async ({ data }): Promise<{ question: string }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");
    const prior = data.priorExchanges.length === 0
      ? "(none — this is the opening question)"
      : data.priorExchanges
          .map((e, i) => `Q${i + 1}: ${e.question}\nA${i + 1}: ${e.answer}`)
          .join("\n");
    const focusBlock = data.focus && data.focus.trim().length > 0
      ? `\nMANAGER-REQUESTED ANGLE (the press has been tipped to lean into this — work it into the question naturally when it fits, but never invent facts):\n${data.focus.trim()}\n`
      : "";
    const user = [
      `DATA (the only facts you may use):`,
      ``,
      data.brief,
      ``,
      `CONTEXT: ${data.context} press conference for ${data.team} (manager: ${data.managerName}).`,
      `THIS IS QUESTION ${data.questionNumber} OF ${data.totalQuestions}.`,
      focusBlock,
      `PRIOR EXCHANGES IN THIS CONFERENCE (do not repeat any topic already addressed):`,
      prior,
      ``,
      `Ask the next question. JSON object only.`,
    ].join("\n");
    const content = await callGateway(apiKey, NEXT_QUESTION_RULES, user, 0.95);
    const parsed = extractJson<{ question?: unknown }>(content);
    const q = typeof parsed?.question === "string" ? parsed.question.trim() : "";
    if (!q) throw new Error("AI returned no usable question");
    return { question: q };
  });

// ---------------- 2. Score an answer ----------------
const SCORE_RULES = `
You are an analyst rating the on-record press-conference response of a club manager. Read their answer carefully and decide what real-world EFFECT it would have on team morale, individual player morale, and the manager's RELATIONSHIP with other clubs' managers — purely from the words said.

ABSOLUTE RULES:
- ONLY reference teams, managers, and players present in the VALID lists provided. If the manager spoke about no one specific, return an empty targets array.
- BE DECISIVE. Bland/generic answers get ±0 to ±2. Pointed, memorable, in-character answers should MOVE things — do not default everything to ±1. Use the full range.
- A manager talking about THEIR OWN team / player carries more weight than talking about a rival's.
- Praise → positive deltas. Criticism / blame / dismissal → negative deltas. Neutral analysis → no target.
- Insulting another manager personally → strongly negative relationDelta with that manager's team. Public praise → strongly positive.
- Self-talk or generic banter has NO targets.
- "respectDelta" is -15..+15 and reflects how the press and public judge THIS answer. USE THE FULL RANGE — do not cluster around ±1:
    * 0 = forgettable filler,
    * ±1..±2 = mildly on/off-key,
    * ±3..±5 = clearly sharp OR clearly weak (most in-character answers land here or higher),
    * ±6..±9 = standout — visionary leadership speech / damning gaffe / brutal put-down / genuine class,
    * ±10..±15 = CAREER-DEFINING — reserved for the extremes: shameless self-promotion, throwing your own stars under the bus, viciously insulting a rival manager by name, blaming refs for a loss, refusing to answer, profanity, an inspiring rally cry, principled stand, or genuinely brilliant wit. Do NOT cap at ±3 or ±5 when the answer truly earns more; if it's the kind of quote that would lead a sports news cycle, score it ±10 or higher.
- If the answer is genuinely hateful/insulting/reckless, the AI should go NEGATIVE 10+. If it's genuinely inspiring/masterful, POSITIVE 10+. Err toward volatility over safety.
- "harshness" is 0..1 — 0 = sugary, 0.5 = balanced, 1 = scathing.

OUTPUT FORMAT — JSON object exactly:
{
  "targets": [
    {"kind":"team","name":"<valid team>","moraleDelta":<int -20..20>},
    {"kind":"player","team":"<valid team>","name":"<valid player on that team>","moraleDelta":<int -30..30>},
    {"kind":"manager","team":"<valid team>","relationDelta":<int -20..20>}
  ],
  "respectDelta": <number -15..15>,
  "harshness": <number 0..1>,
  "summary": "<one short clause, max 80 chars>"
}
No prose outside the JSON.
`;

export const scorePressAnswer = createServerFn({ method: "POST" })
  .inputValidator((data: ScoreInput) => {
    if (!data || typeof data.answer !== "string" || data.answer.trim().length === 0) {
      throw new Error("Empty answer");
    }
    return data;
  })
  .handler(async ({ data }): Promise<PressScoreResult> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const teams = data.validTeams.join(", ");
    const managers = data.validManagers
      .map((m) => `${m.name} (${m.team})`)
      .join(", ");
    // Trim player list to keep prompt bounded (top ~120 players is plenty).
    const players = data.validPlayers
      .slice(0, 160)
      .map((p) => `${p.name} [${p.team}]`)
      .join(", ");

    const user = [
      `DATA (the only facts you may use):`,
      ``,
      data.brief,
      ``,
      `VALID TEAMS: ${teams}`,
      `VALID MANAGERS: ${managers}`,
      `VALID PLAYERS: ${players}`,
      ``,
      `CONTEXT: ${data.context} press conference for ${data.team} (manager: ${data.managerName}).`,
      `REPORTER QUESTION: ${data.question}`,
      `MANAGER'S ANSWER: ${data.answer}`,
      ``,
      `Score the answer. JSON object only.`,
    ].join("\n");

    const content = await callGateway(apiKey, SCORE_RULES, user, 0.6);
    const parsed = extractJson<{
      targets?: unknown[]; respectDelta?: unknown; harshness?: unknown; summary?: unknown;
    }>(content);
    if (!parsed) return { targets: [], respectDelta: 0, harshness: 0.5, summary: "" };

    const validTeams = new Set(data.validTeams);
    const validMgrTeams = new Set(data.validManagers.map((m) => m.team));
    const validPlayerKey = new Set(data.validPlayers.map((p) => `${p.team}::${p.name}`));

    const targets: PressTarget[] = [];
    for (const raw of Array.isArray(parsed.targets) ? parsed.targets : []) {
      const r = raw as Record<string, unknown>;
      const kind = r.kind;
      if (kind === "team") {
        const name = typeof r.name === "string" ? r.name : "";
        if (!validTeams.has(name)) continue;
        targets.push({ kind, name, moraleDelta: clampDelta(Number(r.moraleDelta), 15) });
      } else if (kind === "player") {
        const team = typeof r.team === "string" ? r.team : "";
        const name = typeof r.name === "string" ? r.name : "";
        if (!validPlayerKey.has(`${team}::${name}`)) continue;
        targets.push({ kind, team, name, moraleDelta: clampDelta(Number(r.moraleDelta), 25) });
      } else if (kind === "manager") {
        const team = typeof r.team === "string" ? r.team : "";
        if (!validMgrTeams.has(team)) continue;
        targets.push({ kind, team, relationDelta: clampDelta(Number(r.relationDelta), 15) });
      }
    }
    return {
      targets,
      respectDelta: clampDelta(Number(parsed.respectDelta), 8),
      harshness: clamp01(Number(parsed.harshness)),
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 120) : "",
    };
  });

function clampDelta(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-max, Math.min(max, Math.round(n)));
}
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// ---------------- 3. Recap article ----------------
const RECAP_RULES = `
Write a tight, sports-section-style write-up of a press conference. Lead with the most newsworthy line. Use ONLY the data in the brief and the answers the manager actually gave. 100-220 words. Plain prose, no markdown headings or bullet lists. No invented quotes — paraphrase or quote the manager verbatim.
`;

export const writePressRecap = createServerFn({ method: "POST" })
  .inputValidator((data: RecapInput) => {
    if (!data || !Array.isArray(data.exchanges) || data.exchanges.length === 0) {
      throw new Error("No exchanges to recap");
    }
    return data;
  })
  .handler(async ({ data }): Promise<{ article: string }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");
    const user = [
      `BRIEF:`,
      data.brief,
      ``,
      `CONTEXT: ${data.context} press conference, ${data.team}, manager ${data.managerName}.`,
      `EXCHANGES:`,
      ...data.exchanges.map((e, i) => `Q${i + 1}: ${e.question}\nA${i + 1}: ${e.answer}`),
    ].join("\n");
    const content = await callGateway(apiKey, RECAP_RULES, user, 0.8, false);
    return { article: content };
  });

// ---------------- 4. Full AI manager press conference (one shot) ----------------
// Runs an AI-controlled manager's weekly press conference in a SINGLE call to
// keep credit use bounded. Returns 1-3 Q&A pairs plus the same target-effects
// shape as scorePressAnswer so the client can apply morale/relation/respect
// deltas without further round trips.
interface AiPressInput {
  team: string;
  managerName: string;
  managerPersonality?: string;
  brief: string;
  validTeams: string[];
  validManagers: { team: string; name: string }[];
  validPlayers: { team: string; name: string }[];
}

const AI_PRESS_RULES = `
You are simulating a full weekly press conference for an AI-controlled Eden League manager. You will play BOTH the reporter (asking questions) and the manager (answering in character).

ABSOLUTE RULES:
- Use ONLY facts present in the DATA / BRIEF block, the VALID lists, and prior on-record press quotes shown in the brief.
- Generate 1 to 3 Q&A pairs total. Keep it lean (this is a routine weekly press, not a championship event). Default to 2 unless there is a clearly newsworthy storyline that justifies a third question.
- The manager's voice MUST match their stated personality. Combative personalities push back, jab, or rant; warm personalities praise; quiet personalities stay terse. They are a real person — they can taunt rivals, defend their players, complain about the schedule, or take a shot at another club's manager if it fits their character and recent events.
- Each answer is 1-3 sentences, conversational, plausible from a real manager.
- Score the WHOLE conference's effect via the targets array — same shape as a user press conference. Reserve big magnitudes for genuinely pointed answers.

OUTPUT FORMAT — JSON object exactly:
{
  "exchanges": [ {"question":"...","answer":"..."}, ... ],
  "targets": [
    {"kind":"team","name":"<valid team>","moraleDelta":<int -20..20>},
    {"kind":"player","team":"<valid team>","name":"<valid player on that team>","moraleDelta":<int -30..30>},
    {"kind":"manager","team":"<valid team>","relationDelta":<int -20..20>}
  ],
  "respectDelta": <number -15..15>,
  "harshness": <number 0..1>,
  "summary": "<one short clause, max 80 chars>"
}
No prose outside the JSON.
`;

export interface AiPressResult {
  exchanges: { question: string; answer: string }[];
  targets: PressTarget[];
  respectDelta: number;
  harshness: number;
  summary: string;
}

export const runAiPressConference = createServerFn({ method: "POST" })
  .inputValidator((data: AiPressInput) => {
    if (!data || typeof data.brief !== "string" || data.brief.trim().length === 0) {
      throw new Error("Missing press brief");
    }
    return data;
  })
  .handler(async ({ data }): Promise<AiPressResult> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");
    const teams = data.validTeams.join(", ");
    const managers = data.validManagers.map((m) => `${m.name} (${m.team})`).join(", ");
    const players = data.validPlayers.slice(0, 160).map((p) => `${p.name} [${p.team}]`).join(", ");
    const user = [
      `DATA (the only facts you may use):`,
      ``,
      data.brief,
      ``,
      `VALID TEAMS: ${teams}`,
      `VALID MANAGERS: ${managers}`,
      `VALID PLAYERS: ${players}`,
      ``,
      `THIS IS THE WEEKLY PRESS CONFERENCE FOR ${data.team}.`,
      `MANAGER: ${data.managerName}.`,
      `MANAGER PERSONALITY: ${data.managerPersonality ?? "Balanced, professional."}`,
      ``,
      `Generate 1-3 Q&A pairs plus the effects payload. JSON object only.`,
    ].join("\n");
    const content = await callGateway(apiKey, AI_PRESS_RULES, user, 0.9);
    const parsed = extractJson<{
      exchanges?: unknown; targets?: unknown[]; respectDelta?: unknown;
      harshness?: unknown; summary?: unknown;
    }>(content);
    if (!parsed) return { exchanges: [], targets: [], respectDelta: 0, harshness: 0.5, summary: "" };

    const rawEx = Array.isArray(parsed.exchanges) ? parsed.exchanges : [];
    const exchanges = rawEx
      .map((r) => {
        const rr = r as Record<string, unknown>;
        const q = typeof rr.question === "string" ? rr.question.trim() : "";
        const a = typeof rr.answer === "string" ? rr.answer.trim() : "";
        return q && a ? { question: q, answer: a } : null;
      })
      .filter((x): x is { question: string; answer: string } => !!x)
      .slice(0, 3);

    const validTeams = new Set(data.validTeams);
    const validMgrTeams = new Set(data.validManagers.map((m) => m.team));
    const validPlayerKey = new Set(data.validPlayers.map((p) => `${p.team}::${p.name}`));
    const targets: PressTarget[] = [];
    for (const raw of Array.isArray(parsed.targets) ? parsed.targets : []) {
      const r = raw as Record<string, unknown>;
      const kind = r.kind;
      if (kind === "team") {
        const name = typeof r.name === "string" ? r.name : "";
        if (!validTeams.has(name)) continue;
        targets.push({ kind, name, moraleDelta: clampDelta(Number(r.moraleDelta), 15) });
      } else if (kind === "player") {
        const team = typeof r.team === "string" ? r.team : "";
        const name = typeof r.name === "string" ? r.name : "";
        if (!validPlayerKey.has(`${team}::${name}`)) continue;
        targets.push({ kind, team, name, moraleDelta: clampDelta(Number(r.moraleDelta), 25) });
      } else if (kind === "manager") {
        const team = typeof r.team === "string" ? r.team : "";
        if (!validMgrTeams.has(team)) continue;
        targets.push({ kind, team, relationDelta: clampDelta(Number(r.relationDelta), 15) });
      }
    }
    return {
      exchanges,
      targets,
      respectDelta: clampDelta(Number(parsed.respectDelta), 8),
      harshness: clamp01(Number(parsed.harshness)),
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 120) : "",
    };
  });
