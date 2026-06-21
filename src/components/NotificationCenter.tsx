import { useEffect, useRef, useState } from "react";
import { useLeague } from "@/state/league";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { subscribeAiStatus } from "@/lib/ai-status";
import { subscribeAppNotif } from "@/lib/app-notifications";

type NotifKind =
  | "return"
  | "injury"
  | "suspension"
  | "leader"
  | "trades"
  | "week"
  | "champion"
  | "sack"
  | "ai-credits"
  | "ai-rate"
  | "ai-fallback"
  | "dm"
  | "press-mention";


interface Notif {
  id: string;
  kind: NotifKind;
  title: string;
  detail?: string;
  ts: number;
}

const KIND_META: Record<NotifKind, { icon: string; tone: string }> = {
  return: { icon: "↩", tone: "text-success" },
  injury: { icon: "+", tone: "text-highlight-red" },
  suspension: { icon: "▮", tone: "text-highlight-red" },
  leader: { icon: "★", tone: "text-stadium-gold" },
  trades: { icon: "⇄", tone: "text-highlight-blue" },
  week: { icon: "›", tone: "text-muted-foreground" },
  champion: { icon: "🏆", tone: "text-stadium-gold" },
  sack: { icon: "⚑", tone: "text-highlight-red" },
  "ai-credits": { icon: "⚡", tone: "text-highlight-red" },
  "ai-rate": { icon: "⏳", tone: "text-stadium-gold" },
  "ai-fallback": { icon: "⇨", tone: "text-highlight-blue" },
  dm: { icon: "✉", tone: "text-highlight-blue" },
  "press-mention": { icon: "🎤", tone: "text-highlight-red" },
};

const PROVIDER_LABELS: Record<string, string> = {
  lovable: "Lovable AI",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
};


// Collect the set of players currently out, keyed "Team::Player".
function outSet(teams: ReturnType<typeof useLeague>["state"]["teams"], order: string[]) {
  const out = new Map<string, { team: string; player: string; injury: boolean }>();
  for (const name of order) {
    const t = teams[name];
    if (!t) continue;
    for (const p of t.players) {
      if (p.injuryWeeks > 0 || p.suspensionWeeks > 0) {
        out.set(`${name}::${p.name}`, {
          team: name,
          player: p.name,
          injury: p.injuryWeeks > 0,
        });
      }
    }
  }
  return out;
}

export function NotificationCenter() {
  const { state, standings } = useLeague();
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [open, setOpen] = useState(false);
  const counter = useRef(0);

  // Previous snapshots of the signals we diff against.
  const prev = useRef<{
    leader: string | null;
    proposals: number;
    week: number;
    champion: string | null;
    out: Map<string, { team: string; player: string; injury: boolean }>;
    sacked: Set<string>;
    init: boolean;
  }>({ leader: null, proposals: 0, week: 0, champion: null, out: new Map(), sacked: new Set(), init: false });

  function push(items: Omit<Notif, "id" | "ts">[]) {
    if (items.length === 0) return;
    const ts = Date.now();
    setNotifs((cur) => {
      const added = items.map((n) => ({ ...n, id: `n${counter.current++}`, ts }));
      return [...added, ...cur].slice(0, 40);
    });
  }

  // Surface AI Gateway status events (credits exhausted, rate-limited) raised
  // from anywhere in the app. Throttled so a burst of failed calls doesn't spam.
  const lastAi = useRef<{ credits: number; rate: number; fallback: Record<string, number> }>({
    credits: 0,
    rate: 0,
    fallback: {},
  });
  useEffect(() => {
    return subscribeAiStatus((s) => {
      const now = Date.now();
      if (s.kind === "credits") {
        if (now - lastAi.current.credits < 60_000) return;
        lastAi.current.credits = now;
        push([{
          kind: "ai-credits",
          title: "AI Credits Exhausted",
          detail: "All AI providers are out of credits or unreachable. Add credits to resume press conferences, DMs, scouting and trade chatter.",
        }]);
      } else if (s.kind === "rate_limit") {
        if (now - lastAi.current.rate < 30_000) return;
        lastAi.current.rate = now;
        push([{
          kind: "ai-rate",
          title: "AI is Rate-Limited",
          detail: "Too many AI calls in a short window. Wait a moment before retrying.",
        }]);
      } else if (s.kind === "fallback") {
        const provider = s.provider;
        const last = lastAi.current.fallback[provider] ?? 0;
        if (now - last < 60_000) return;
        lastAi.current.fallback[provider] = now;
        push([{
          kind: "ai-fallback",
          title: `AI switched to ${PROVIDER_LABELS[provider] ?? provider}`,
          detail: "Lovable AI is unavailable or out of credits — the next provider in the fallback chain handled this request.",
        }]);
      }
    });
  }, []);


  useEffect(() => {
    const leader = standings[0]?.team ?? null;
    const proposals = state.tradeProposals.length;
    const week = state.currentWeek;
    const champion = state.playoffs?.champion ?? null;
    const out = outSet(state.teams, state.teamOrder);
    // Clubs whose manager has just been sacked: flagged for AI regeneration or
    // currently being held by a caretaker.
    const sacked = new Set<string>();
    for (const [team, m] of Object.entries(state.managers ?? {})) {
      if (m.pendingGeneration || m.name === "Interim Manager") sacked.add(team);
    }
    const p = prev.current;

    if (!p.init) {
      prev.current = { leader, proposals, week, champion, out, sacked, init: true };
      return;
    }

    const batch: Omit<Notif, "id" | "ts">[] = [];

    // Returns vs new absences (diff the out-set).
    for (const [key, info] of out) {
      if (!p.out.has(key)) {
        batch.push({
          kind: info.injury ? "injury" : "suspension",
          title: info.injury ? "Player Injured" : "Player Suspended",
          detail: `${info.player} (${info.team}) is now in the reserves.`,
        });
      }
    }
    for (const [key, info] of p.out) {
      if (!out.has(key)) {
        batch.push({
          kind: "return",
          title: "Player Returns from Reserves",
          detail: `${info.player} (${info.team}) is back and restored to their spot.`,
        });
      }
    }

    // Standings leader change (only once any matches are played).
    if (leader && leader !== p.leader && (standings[0]?.pld ?? 0) > 0) {
      batch.push({
        kind: "leader",
        title: "New Standings Leader",
        detail: `${leader} now tops the table.`,
      });
    }

    // New trade proposals awaiting confirmation.
    if (proposals > p.proposals) {
      const added = proposals - p.proposals;
      batch.push({
        kind: "trades",
        title: "New Trade Proposals Awaiting Confirmation",
        detail: `${added} new deal${added === 1 ? "" : "s"} on the Automatic Trade Desk (${proposals} total).`,
      });
    }

    // Week advanced.
    if (week > p.week) {
      batch.push({
        kind: "week",
        title: "Match Week Advanced",
        detail: `The league has progressed to Week ${week}.`,
      });
    }

    // Champion crowned.
    if (champion && champion !== p.champion) {
      batch.push({
        kind: "champion",
        title: "League Champion Crowned",
        detail: `${champion} have won the Eden League!`,
      });
    }

    // Manager sacked (newly entered the sacked/caretaker state).
    for (const team of sacked) {
      if (!p.sacked.has(team)) {
        batch.push({
          kind: "sack",
          title: "Manager Sacked",
          detail: `${team} have parted ways with their manager after a morale collapse. A replacement is being appointed.`,
        });
      }
    }

    prev.current = { leader, proposals, week, champion, out, sacked, init: true };
    push(batch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, standings]);

  function dismiss(id: string) {
    setNotifs((cur) => cur.filter((n) => n.id !== id));
  }
  function clearAll() {
    setNotifs([]);
  }

  const count = notifs.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-label="Notifications"
          className="relative select-none rounded-md border border-input bg-background px-2 py-1 text-base transition-colors hover:bg-accent"
        >
          🔔
          {count > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-highlight-red px-1 text-[10px] font-bold text-white">
              {count > 9 ? "9+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-extrabold uppercase tracking-wide">Notifications</span>
          {count > 0 && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={clearAll}>
              CLEAR ALL
            </Button>
          )}
        </div>
        {count === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            You're all caught up. League events will appear here.
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            {notifs.map((n) => {
              const meta = KIND_META[n.kind];
              return (
                <div key={n.id} className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
                  <span className={`mt-0.5 text-sm font-bold ${meta.tone}`}>{meta.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold leading-tight">{n.title}</p>
                    {n.detail && <p className="mt-0.5 text-[11px] text-muted-foreground">{n.detail}</p>}
                  </div>
                  <button
                    aria-label="Dismiss"
                    onClick={() => dismiss(n.id)}
                    className="shrink-0 rounded px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
