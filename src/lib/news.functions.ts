import { createServerFn } from "@tanstack/react-start";
import { chatCompletion } from "./ai-fallback.server";


// News Suite — entertainment-only AI article generator.
// The CLIENT assembles a fact brief from REAL league state (scores, scorers,
// ratings, standings, injuries, cards) and passes it here as a plain string.
// This function never invents data; it only narrates the facts it is given.

export type NewsKind = "postgame" | "roundup" | "drama";

interface NewsInput {
  kind: NewsKind;
  brief: string; // pre-formatted factual digest assembled on the client
  focus?: string; // optional reader-supplied angle/specification for the story
}

const SYSTEM_BY_KIND: Record<NewsKind, string> = {
  postgame:
    "You are a veteran soccer beat writer filing a post-match report for the Eden League.",
  roundup:
    "You are a senior soccer columnist writing a league-wide weekly roundup for the Eden League.",
  drama:
    "You are a sharp, gossip-savvy soccer feature writer covering the off-pitch storylines, rivalries, and media drama of the Eden League.",
};

const SHARED_RULES = `
Eden League is a fictional 24-team 9v9 soccer league. Write vivid, human, opinionated coverage.

ABSOLUTE RULES — these are non-negotiable:
- Use ONLY the facts in the DATA block below. Never invent scores, scorers, assists, cards, injuries, ratings, standings, dates, quotes, attendances, or player/team names that are not present in the DATA.
- If you want to add color (atmosphere, tactical reads, momentum), it must be plausible analysis grounded in the supplied numbers — never fabricated events.
- Do NOT fabricate direct quotes. If you reference sentiment, frame it as the writer's read ("you sense...", "the body language suggested..."), not as a real quotation.
- Player ratings are on a 1–10 scale; treat higher as better.

ACT LIKE A REAL ANALYST — this is critical:
- You are given a rich LEAGUE-WIDE ANALYTICAL CONTEXT block: squad strengths, full key-player ratings & values, tactical styles & formations, recent form, remaining schedules with opponent strength, absentees, budgets, and a note on how the match engine weighs attributes/tactics. USE IT.
- When the EDITOR'S BRIEF asks a pointed question, ANSWER IT DIRECTLY with a clear verdict, then justify it with the data. Examples of the kind of question you must be able to answer with conviction:
  • "Is team X's tactic working, or is there a better option?" → judge their style vs their squad's attributes and recent form, say yes/no, and name a concrete alternative if warranted.
  • "How does losing injured player Y affect their lineup and tactics?" → reason about who replaces them, the drop in the relevant attributes, and the tactical knock-on.
  • "Analyse team X's remaining schedule — is it hard or easy vs everyone else's?" → compare their remaining opponents' strengths to the league and give a clear difficulty verdict.
- Do NOT hedge into vague non-answers. Commit to a position like a confident pundit, grounded in the numbers.
- IMPORTANT BALANCE RULE: do NOT default to talking about team morale or the top-scorer / golden-boot race every time. Those are minor supporting details — only mention them if they are genuinely the most relevant angle to the story or the editor's brief. Lead instead with tactics, matchups, squad quality, form, and schedule.

TONE:
- Highly strategic and analytical: read the tactics, the matchups, the table implications.
- Witty and authentic to soccer culture — confident voice, dry humor, real terminology.
- Avoid rigid, mechanical, robotic, list-like prose. Write flowing paragraphs a real columnist would publish.

FORMAT:
- Start with a bold, punchy headline as a markdown H2 (## Headline).
- Then 2–4 tight paragraphs. No bullet-point stat dumps.
- Keep it under ~320 words (a focused analytical answer may run a little longer if the question demands it).
`;

export const generateNews = createServerFn({ method: "POST" })
  .inputValidator((data: NewsInput) => {
    if (!data || (data.kind !== "postgame" && data.kind !== "roundup" && data.kind !== "drama")) {
      throw new Error("Invalid news kind");
    }
    if (typeof data.brief !== "string" || data.brief.trim().length === 0) {
      throw new Error("Missing data brief");
    }
    const focus =
      typeof data.focus === "string" ? data.focus.trim().slice(0, 500) : "";
    return { ...data, focus };
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI is not configured");

    const system = `${SYSTEM_BY_KIND[data.kind]}\n${SHARED_RULES}`;
    const userContent = data.focus
      ? `DATA (the only facts you may use):\n\n${data.brief}\n\nEDITOR'S BRIEF — center the article on this angle: "${data.focus}". Use ONLY the facts above to support it; if the data does not back up part of the requested angle, lean on what the data does show rather than inventing anything. Write the article now.`
      : `DATA (the only facts you may use):\n\n${data.brief}\n\nWrite the article now.`;

    const { content } = await chatCompletion({
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      temperature: 0.9,
      structured: false,
    });
    const article = content.trim();
    if (!article) throw new Error("AI returned an empty article");
    return { article };

  });
