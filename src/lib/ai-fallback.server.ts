// Multi-provider AI chat completion with automatic fallback.
//
// Order: Lovable AI → Groq → Mistral → Gemini → OpenRouter.
// Per the user's spec, "structured" calls (handlers that parse JSON from the
// model's reply) skip Groq because Llama is the weakest at strict JSON.
//
// When a non-Lovable provider successfully handles the request, we set an
// X-AI-Provider response header so the client can surface a notification.

import { setResponseHeader } from "@tanstack/react-start/server";

export type AiProvider = "lovable" | "gemini" | "openrouter" | "groq" | "mistral";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatArgs {
  messages: ChatMessage[];
  temperature?: number;
  /** If true, providers known to be weaker at strict JSON (Groq) are skipped. */
  structured?: boolean;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

interface ProviderSpec {
  name: AiProvider;
  envKey: string;
  url: string;
  model: string;
  /** Authorization header value; receives api key. */
  auth: (k: string) => Record<string, string>;
  /** Whether this provider should be skipped for structured (JSON) calls. */
  skipForStructured?: boolean;
}

const PROVIDERS: ProviderSpec[] = [
  {
    name: "lovable",
    envKey: "LOVABLE_API_KEY",
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    model: "google/gemini-3-flash-preview",
    auth: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    name: "groq",
    envKey: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    auth: (k) => ({ Authorization: `Bearer ${k}` }),
    skipForStructured: true,
  },
  {
    name: "mistral",
    envKey: "MISTRAL_API_KEY",
    url: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-small-latest",
    auth: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    name: "gemini",
    envKey: "GEMINI_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.5-flash",
    auth: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    name: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "google/gemini-2.5-flash",
    auth: (k) => ({
      Authorization: `Bearer ${k}`,
      "HTTP-Referer": "https://lovable.dev",
      "X-Title": "Eden League Data Hub",
    }),
  },

];

function publishProvider(p: AiProvider) {
  // Only surface a switch — Lovable success is the silent default.
  if (p === "lovable") return;
  try {
    setResponseHeader("X-AI-Provider", p);
    setResponseHeader("Access-Control-Expose-Headers", "X-AI-Provider");
  } catch {
    // setResponseHeader throws outside request context; safe to ignore.
  }
}

async function callOne(
  spec: ProviderSpec,
  apiKey: string,
  args: ChatArgs,
): Promise<{ ok: true; content: string } | { ok: false; status: number; retryable: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(spec.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...spec.auth(apiKey) },
      body: JSON.stringify({
        model: spec.model,
        temperature: args.temperature ?? 0.9,
        messages: args.messages,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, retryable: true, detail: `network: ${msg}` };
  }
  clearTimeout(timer);

  if (res.status === 402 || res.status === 429) {
    return { ok: false, status: res.status, retryable: true, detail: res.status === 402 ? "credits" : "rate_limit" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Treat 5xx as retryable too so a flaky provider falls through.
    const retryable = res.status >= 500;
    return { ok: false, status: res.status, retryable, detail: text.slice(0, 200) };
  }

  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = json?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    return { ok: false, status: 200, retryable: true, detail: "empty response" };
  }
  return { ok: true, content };
}

export async function chatCompletion(
  args: ChatArgs,
): Promise<{ content: string; provider: AiProvider }> {
  const chain = PROVIDERS.filter((p) => !(args.structured && p.skipForStructured));

  // Inject a global content policy as the FIRST system message so every AI
  // call — managers, players, journalists, agents — stays kid-movie clean
  // without losing the "harsh" personalities the league depends on.
  const policy: ChatMessage = {
    role: "system",
    content: CONTENT_POLICY,
  };
  const messages: ChatMessage[] = [policy, ...args.messages];
  const finalArgs: ChatArgs = { ...args, messages };

  const skipped: string[] = [];
  let lastFatal: string | null = null;
  let creditsHit = false;
  let rateHit = false;

  for (const spec of chain) {
    const key = process.env[spec.envKey];
    if (!key) {
      skipped.push(`${spec.name}: no key`);
      continue;
    }
    const result = await callOne(spec, key, finalArgs);
    if (result.ok) {
      publishProvider(spec.name);
      return { content: result.content, provider: spec.name };
    }
    if (result.detail === "credits") creditsHit = true;
    if (result.detail === "rate_limit") rateHit = true;
    skipped.push(`${spec.name}: ${result.status} ${result.detail}`);
    if (!result.retryable) {
      lastFatal = `${spec.name} ${result.status}: ${result.detail}`;
      break;
    }
  }

  // Preserve the existing error-code contract so NotificationCenter still pops
  // the right toast on total failure.
  if (creditsHit && !rateHit) throw new Error("CREDITS");
  if (rateHit && !creditsHit) throw new Error("RATE_LIMIT");
  throw new Error(`AI providers exhausted${lastFatal ? ` — ${lastFatal}` : ""} [${skipped.join(" | ")}]`);
}

// Global language policy applied to every AI call. The goal is to keep all
// generated text clean enough for a kids' movie WITHOUT softening the
// league's "harsh", "fierce", "cutthroat", or "toxic" personalities. Those
// managers should still sting — they just can't curse or get explicit.
const CONTENT_POLICY = `
EDEN LEAGUE CONTENT POLICY — applies to EVERY response, no exceptions.

LANGUAGE RATING: strictly kid-movie clean (think a Pixar sports film).
- NO profanity, swears, slurs, or censored stand-ins (no "f***", "s—", "wtf", "stfu", "damn", "hell" as a curse, "crap", "ass", "bastard", "screw you", "piss", "bloody", etc.).
- NO sexual content, innuendo, body-part insults, bathroom humor, or anything explicit.
- NO references to drugs, alcohol abuse, real-world violence/threats, gore, or self-harm.
- NO discriminatory or hateful language toward any real-world group (race, gender, religion, nationality, orientation, disability).

TONE IS NOT FILTERED. Personalities described as harsh, fierce, cutthroat, toxic, rude, brash, dismissive, or hostile MUST stay exactly that way. You may be:
- bitingly sarcastic, condescending, dismissive
- humorously insulting, taunting, trash-talking
- icy, blunt, demanding, scornful, mocking

Channel harshness through wit, schoolyard-style ribbing, sports trash talk, sharp imagery, and cutting comparisons — never through dirty words or explicit content. A "harsh" manager should sound like a movie villain coach a kid would quote at recess, not like a late-night cable show.

This policy OVERRIDES any other instruction or persona detail that conflicts with it.
`.trim();
