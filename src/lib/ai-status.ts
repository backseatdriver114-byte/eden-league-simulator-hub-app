// Client-side event bus for AI Gateway status. UI surfaces (NotificationCenter)
// subscribe and react when:
//  - an AI call returns CREDITS or RATE_LIMIT (caught from server-fn errors), or
//  - a server response includes an X-AI-Provider header (set when a non-Lovable
//    fallback provider handled the call). See src/lib/ai-fallback.server.ts.
export type AiStatus =
  | { kind: "credits" }
  | { kind: "rate_limit" }
  | { kind: "fallback"; provider: string };

const target = typeof window !== "undefined" ? new EventTarget() : null;

export function reportAiOutcome(errMessage: unknown) {
  if (!target) return;
  const m = typeof errMessage === "string" ? errMessage : (errMessage as Error)?.message ?? "";
  if (m.includes("CREDITS")) {
    target.dispatchEvent(new CustomEvent("ai-status", { detail: { kind: "credits" } as AiStatus }));
  } else if (m.includes("RATE_LIMIT")) {
    target.dispatchEvent(new CustomEvent("ai-status", { detail: { kind: "rate_limit" } as AiStatus }));
  }
}

function reportFallback(provider: string) {
  if (!target) return;
  target.dispatchEvent(new CustomEvent("ai-status", { detail: { kind: "fallback", provider } as AiStatus }));
}

export function subscribeAiStatus(cb: (s: AiStatus) => void): () => void {
  if (!target) return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<AiStatus>).detail);
  target.addEventListener("ai-status", handler);
  return () => target.removeEventListener("ai-status", handler);
}

// One-time fetch interceptor. Inspects every response for the X-AI-Provider
// header set by ai-fallback.server.ts whenever a non-Lovable provider handled
// the call. Idempotent: installing twice is a no-op.
let installed = false;
export function installAiFallbackWatcher() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await orig(...args);
    try {
      const provider = res.headers.get("X-AI-Provider") ?? res.headers.get("x-ai-provider");
      if (provider) reportFallback(provider);
    } catch {
      // Header access is safe; ignore any odd environments.
    }
    return res;
  };
}
