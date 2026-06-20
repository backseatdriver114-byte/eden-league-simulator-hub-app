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

// ---------------- 2. Score an answer ----------------
const SCORE_RULES = `
You are an analyst rating the on-record press-conference response of a club manager. Read their answer carefully and decide what real-world EFFECT it would have on team morale, individual player morale, and the manager's RELATIONSHIP with other clubs' managers — purely from the words said.

ABSOLUTE RULES:
- ONLY reference teams, managers, and players present in the VALID lists provided. If the manager spoke about no one specific, return an empty targets array.
- Effects are SMALL by default (most answers nudge things ±1 to ±5). Reserve big magnitudes for explicit, pointed remarks.
- A manager talking about THEIR OWN team / player carries more weight than talking about a rival's.
- Praise → positive deltas. Criticism / blame / dismissal → negative deltas. Neutral analysis → no target.
- Insulting another manager personally → negative relationDelta with that manager's team. Public praise → positive.
- Self-talk or generic banter has NO targets.
- "respectDelta" is a tiny ±1 to ±3 reflecting how the press would judge this answer — measured (-1..+1), sharp & insightful (+1..+3), pure cheer or pure vitriol (-1..-3).
- "harshness" is 0..1 — 0 = sugary, 0.5 = balanced, 1 = scathing.

OUTPUT FORMAT — JSON object exactly:
{
  "targets": [
    {"kind":"team","name":"<valid team>","moraleDelta":<int -15..15>},
    {"kind":"player","team":"<valid team>","name":"<valid player on that team>","moraleDelta":<int -25..25>},
    {"kind":"manager","team":"<valid team>","relationDelta":<int -15..15>}
  ],
  "respectDelta": <number -3..3>,
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
      respectDelta: clampDelta(Number(parsed.respectDelta), 3),
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
