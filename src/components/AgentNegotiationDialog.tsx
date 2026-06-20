import { useMemo, useRef, useState } from "react";
import { reportAiOutcome } from "@/lib/ai-status";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useLeague, type LeaguePlayer } from "@/state/league";
import { calculateMarketValue } from "@/lib/contracts";
import {
  negotiateAgent, generateAgentLocally,
  type AgentTurn, type AgentProfile,
} from "@/lib/agent-negotiation.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// Contract talks with a player's agent — user-controlled clubs only.
// Mirrors the Negotiation Suite's manager-talks flow, but at the player level.
export function AgentNegotiationDialog({
  open, team, index, player, onClose,
}: {
  open: boolean;
  team: string;
  index: number;
  player: LeaguePlayer | null;
  onClose: () => void;
}) {
  const { state, setPlayerAgent, signNewContract } = useLeague();
  const run = useServerFn(negotiateAgent);

  // Lazily mint an agent the first time we open talks for this player.
  const agent: AgentProfile | null = useMemo(() => {
    if (!player) return null;
    if (player.agent) return player.agent;
    const takenNames: string[] = [];
    for (const t of Object.values(state.teams)) {
      for (const p of t.players) {
        if (p.agent?.name) takenNames.push(p.agent.name);
        if (p.name) takenNames.push(p.name);
      }
    }
    return generateAgentLocally(takenNames);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player?.name]);

  // Persist the freshly-minted agent the first time we use it.
  // Wrapped in a ref so we only call setPlayerAgent once per open.
  const persistedRef = useRef<string | null>(null);
  if (player && agent && !player.agent && persistedRef.current !== player.name) {
    persistedRef.current = player.name;
    // Defer to next tick so we don't setState during render.
    queueMicrotask(() => setPlayerAgent(team, index, agent));
  }

  const market = player ? calculateMarketValue(player.rating) : 0;
  const [salary, setSalary] = useState(String(player?.salary ?? market));
  const [years, setYears] = useState(String(Math.max(1, player?.contractYears ?? 2)));
  const [messages, setMessages] = useState<AgentTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreedSig, setAgreedSig] = useState<string | null>(null);
  // When the agent walks away, lock all controls so the user can read the final
  // reply before clicking the single CLOSE button.
  const [cancelled, setCancelled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset transient state every time a different player is opened.
  const lastPlayerKey = useRef<string | null>(null);
  if (player && lastPlayerKey.current !== player.name) {
    lastPlayerKey.current = player.name;
    setSalary(String(player.salary ?? market));
    setYears(String(Math.max(1, player.contractYears ?? 2)));
    setMessages([]);
    setInput("");
    setError(null);
    setAgreedSig(null);
    setCancelled(false);
  }

  if (!player || !agent) return null;

  const offerSalary = Math.max(0, parseFloat(salary) || 0);
  const offerYears = Math.max(1, Math.floor(parseFloat(years) || 0));
  const sig = `${offerSalary}|${offerYears}`;
  const dealReady = agreedSig === sig;

  const playerSummary = [
    `Player: ${player.name} (${player.position}), age ${player.age}, OVR ${player.rating.toFixed(1)}, morale ${(player.morale ?? 50).toFixed(0)}/100.`,
    `Current contract: $${(player.salary ?? 0).toFixed(1)}M/yr, ${player.contractYears ?? 0} year(s) remaining.`,
    `Market value (fair benchmark): $${market.toFixed(1)}M/yr.`,
    `Club: ${team}.`,
  ].join("\n");

  async function send() {
    const msg = input.trim();
    if (!msg || loading) return;
    setError(null);
    const history = messages;
    setMessages((m) => [...m, { role: "user", text: msg }]);
    setInput("");
    setLoading(true);
    try {
      const res = await run({
        data: {
          team,
          playerName: player!.name,
          playerSummary,
          agent: agent!,
          offer: { salaryM: offerSalary, years: offerYears },
          history,
          userMessage: msg,
        },
      });
      if (res.cancels) {
        setMessages((m) => [...m, { role: "agent", text: res.reply }]);
        setCancelled(true);
        toast.error(`${agent!.name} has ended the conversation.`);
        requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));
        return;
      }
      setMessages((m) => [...m, { role: "agent", text: res.reply }]);
      setAgreedSig(res.accepts ? sig : null);
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      reportAiOutcome(m);
      if (m.includes("RATE_LIMIT")) setError("The agent is on another call — try again in a moment.");
      else if (m.includes("CREDITS")) setError("AI credits exhausted. Add credits in Settings → Workspace → Usage.");
      else setError("Couldn't reach the agent. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function finalize() {
    signNewContract(team, index, offerSalary, offerYears);
    toast.success("Contract signed", {
      description: `${player!.name} — ${offerYears}yr / $${offerSalary.toFixed(1)}M/yr.`,
    });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !cancelled) onClose(); }}>
      <DialogContent
        className="max-w-2xl"
        onInteractOutside={(e) => { if (cancelled) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (cancelled) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>
            Contract Talks: <span className="text-primary">{player.name}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border-l-4 border-stadium-gold bg-card px-3 py-2 text-xs">
          <div className="font-bold">{agent.name} <span className="text-muted-foreground">— agent</span></div>
          <p className="italic text-muted-foreground">{agent.personality}</p>
          <p className="text-muted-foreground">{agent.tolerance}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Salary offered ($M/yr)</label>
            <Input type="number" min={0} step="0.1" value={salary} onChange={(e) => setSalary(e.target.value)} className="bg-card" />
            <p className="mt-1 text-[10px] text-muted-foreground">Market value: ${market.toFixed(1)}M</p>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Length (years)</label>
            <Input type="number" min={1} max={6} step={1} value={years} onChange={(e) => setYears(e.target.value)} className="bg-card" />
          </div>
        </div>

        {dealReady && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2">
            <span className="text-sm font-semibold text-success">{agent.name} has agreed to these terms.</span>
            <Button onClick={finalize} className="font-semibold">SIGN CONTRACT</Button>
          </div>
        )}

        <div className="rounded-xl border bg-card p-3">
          <div ref={scrollRef} className="max-h-60 space-y-3 overflow-y-auto pr-1">
            {messages.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Open with an offer or a question. {agent.name} will respond in character — adjust the salary/years above as you haggle.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                <div className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-highlight-blue/10 text-foreground"
                    : "border bg-background text-foreground"
                }`}>
                  {m.role === "agent" && <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{agent.name}</div>}
                  {m.text}
                </div>
              </div>
            ))}
            {loading && <p className="text-xs text-muted-foreground">{agent.name} is considering…</p>}
          </div>

          {error && <div className="mt-2 rounded-lg border-l-4 border-highlight-red bg-background px-3 py-2 text-sm">{error}</div>}

          {cancelled ? (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-highlight-red/40 bg-highlight-red/5 px-3 py-2">
              <span className="text-sm font-semibold text-highlight-red">
                {agent.name} has ended the negotiation.
              </span>
              <Button onClick={onClose} variant="outline" className="font-semibold">CLOSE</Button>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Make your case, propose terms, push back…"
                className="bg-background"
                disabled={loading}
              />
              <Button onClick={send} disabled={loading || !input.trim()} className="font-semibold">Send</Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
