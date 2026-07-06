// Per-provider cooldown book kept in memory (per Worker instance). Populated
// by `ai-fallback.server.ts` when a provider returns 429/402, read by the
// Settings suite's AI selector to grey out unavailable options.

type ProviderName = "lovable" | "gemini" | "openrouter" | "groq" | "mistral";

interface CooldownEntry { until: number; reason: "credits" | "rate_limit" | "error"; note?: string }

const cooldowns: Record<string, CooldownEntry | undefined> = {};

export function markProviderDown(name: ProviderName, reason: CooldownEntry["reason"], ms: number, note?: string) {
  cooldowns[name] = { until: Date.now() + ms, reason, note };
}

export function providerCooldownRemaining(name: ProviderName): CooldownEntry | null {
  const c = cooldowns[name];
  if (!c) return null;
  if (c.until <= Date.now()) { delete cooldowns[name]; return null; }
  return c;
}

export function providerHasKey(name: ProviderName): boolean {
  const envKey = ({
    lovable: "LOVABLE_API_KEY",
    gemini: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    mistral: "MISTRAL_API_KEY",
  } as const)[name];
  return typeof process.env[envKey] === "string" && process.env[envKey]!.length > 0;
}
