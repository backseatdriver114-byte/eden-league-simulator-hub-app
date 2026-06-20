// Messages Suite — private DMs from a user-controlled team's manager to
// rival AI managers OR to players on their own roster. Persisted to Cloud
// (manager_messages table). Every message applies a small morale/relations
// effect via the score returned from the AI server fn.
import { useEffect, useMemo, useRef, useState } from "react";
import { reportAiOutcome } from "@/lib/ai-status";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useLeague, isPlayerOut, type LeaguePlayer } from "@/state/league";
import { sendDm, scoreBroadcast, type Counterpart, type DmTurn } from "@/lib/messages.functions";
import { relationLabel } from "@/lib/relations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface ContactKey {
  userTeam: string;
  kind: Counterpart;
  counterpartTeam: string;
  counterpartName: string;
}
interface RawRow {
  id: string;
  user_team: string;
  counterpart_kind: Counterpart;
  counterpart_team: string;
  counterpart_name: string;
  role: "user" | "ai" | "press";
  content: string;
  created_at: string;
}

function keyOf(c: ContactKey): string {
  return [c.userTeam, c.kind, c.counterpartTeam, c.counterpartName].join("|");
}

function briefForManagerDm(
  userTeam: string, aiTeam: string,
  rels: number | undefined, payroll: string, theirRecord: string,
): string {
  const rel = typeof rels === "number" ? `${rels.toFixed(0)} (${relationLabel(rels)})` : "neutral";
  return [
    `User team: ${userTeam}.`,
    `Their club: ${aiTeam} — record ${theirRecord}.`,
    `Your relationship score (0=hostile, 100=warm): ${rel}.`,
    `Your club payroll: ${payroll}.`,
  ].join("\n");
}

function briefForPlayerDm(p: LeaguePlayer, team: string, teamStanding: string): string {
  const status = p.injuryWeeks > 0 ? `injured ${p.injuryWeeks}wk`
    : p.suspensionWeeks > 0 ? `suspended ${p.suspensionWeeks}wk`
    : p.starter ? "starter" : "bench";
  return [
    `You are ${p.name}, ${p.position}, age ${p.age}, OVR ${p.rating.toFixed(1)} on ${team}.`,
    `Status: ${status}. Morale ${(p.morale ?? 50).toFixed(0)}/100. Contract: $${p.salary.toFixed(1)}M/yr, ${p.contractYears}yr left.`,
    `Your club is currently ${teamStanding}.`,
  ].join("\n");
}

// Pull recent press archive entries that this DM counterpart would
// plausibly know about (everything they were named in, plus quotes the
// user manager has spoken about the counterpart's team / players).
function recentPressFor(
  archive: { season: number; week: number; team: string; managerName: string; context: string; question: string; answer: string; targets?: { kind: string; team?: string; name?: string }[] }[] | undefined,
  opts: { userTeam: string; counterpartKind: "manager" | "player"; counterpartTeam: string; counterpartName: string },
): string {
  if (!archive || archive.length === 0) return "";
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const matches = archive.filter((e) => {
    // The counterpart heard everything from their own manager and about themselves.
    if (opts.counterpartKind === "manager") {
      if (e.team === opts.counterpartTeam) return true; // their own press
      // User talked about their club / players / them as a manager.
      const ts = e.targets ?? [];
      return e.team === opts.userTeam && ts.some((t) =>
        (t.kind === "team" && t.name === opts.counterpartTeam) ||
        (t.kind === "player" && t.team === opts.counterpartTeam) ||
        (t.kind === "manager" && t.team === opts.counterpartTeam),
      );
    }
    // Player: their own manager's press + anything the user said about them by name.
    if (e.team === opts.counterpartTeam) return true;
    const ts = e.targets ?? [];
    return ts.some((t) => t.kind === "player" && t.team === opts.counterpartTeam && t.name === opts.counterpartName);
  }).slice(-6);
  if (matches.length === 0) return "";
  const lines = matches
    .map((e) => `  - S${e.season}W${e.week} ${e.context} — ${e.managerName} (${e.team}): "${flat(e.answer).slice(0, 220)}"`)
    .join("\n");
  return `\nRELEVANT PUBLIC PRESS QUOTES (the counterpart has read/heard these; reference them if it fits):\n${lines}`;
}

export function MessagesSuite() {
  const {
    state, standings,
    applyRelationDelta, applyPlayerMoraleDelta, applyTeamMoraleDelta,
  } = useLeague();
  const sendFn = useServerFn(sendDm);
  const broadcastFn = useServerFn(scoreBroadcast);

  const exempt = state.settings?.contractExemptTeams ?? [];
  const userTeams = state.teamOrder.filter((t) => exempt.includes(t));

  const [userTeam, setUserTeam] = useState(userTeams[0] ?? "");
  const [contact, setContact] = useState<ContactKey | null>(null);
  const [rows, setRows] = useState<RawRow[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const aiManagerContacts = useMemo(() =>
    state.teamOrder
      .filter((t) => t !== userTeam && !exempt.includes(t))
      .map((t) => {
        const m = state.managers?.[t];
        return { team: t, name: m?.name ?? t, personality: m?.personality, respect: m?.respect ?? 50 };
      }),
    [state.teamOrder, state.managers, userTeam, exempt],
  );

  const ownPlayers = useMemo(() => {
    if (!userTeam) return [];
    return (state.teams[userTeam]?.players ?? []).slice().sort((a, b) => b.rating - a.rating);
  }, [state.teams, userTeam]);

  // Load thread when contact changes.
  useEffect(() => {
    if (!contact) { setRows([]); return; }
    let cancelled = false;
    void supabase
      .from("manager_messages")
      .select("*")
      .eq("user_team", contact.userTeam)
      .eq("counterpart_kind", contact.kind)
      .eq("counterpart_team", contact.counterpartTeam)
      .eq("counterpart_name", contact.counterpartName)
      .order("created_at", { ascending: true })
      .then(({ data }) => { if (!cancelled) setRows(((data as unknown) as RawRow[]) ?? []); });
    return () => { cancelled = true; };
  }, [contact ? keyOf(contact) : null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));
  }, [rows.length]);

  if (userTeams.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
        No user-controlled clubs are set. Mark your clubs as contract-exempt in{" "}
        <span className="font-semibold text-foreground">Settings &amp; Version Archives</span> to use private DMs.
      </div>
    );
  }

  async function persist(role: "user" | "ai", content: string): Promise<RawRow | null> {
    if (!contact) return null;
    const { data, error } = await supabase
      .from("manager_messages")
      .insert([{
        user_team: contact.userTeam,
        counterpart_kind: contact.kind,
        counterpart_team: contact.counterpartTeam,
        counterpart_name: contact.counterpartName,
        role,
        content,
      } as never])
      .select()
      .maybeSingle();
    if (error) {
      console.warn("[dm] insert failed", error.message);
      return null;
    }
    return (data as unknown) as RawRow;
  }

  async function deleteThread() {
    if (!contact) return;
    await supabase
      .from("manager_messages")
      .delete()
      .eq("user_team", contact.userTeam)
      .eq("counterpart_kind", contact.kind)
      .eq("counterpart_team", contact.counterpartTeam)
      .eq("counterpart_name", contact.counterpartName);
    setRows([]);
  }

  // Decide whether the AI replies at all this turn. Cheap client-side dice
  // driven by personality + relationship/morale + the last tone the user used.
  // When they "leave you on read" we never call the AI, so it costs 0 credits.
  function shouldReply(lastUserMsg: string): boolean {
    if (!contact) return false;
    // Length signal: a long thoughtful message is harder to ignore.
    const long = lastUserMsg.length > 80 ? 0.1 : 0;
    if (contact.kind === "manager") {
      const personality = (state.managers?.[contact.counterpartTeam]?.personality ?? "").toLowerCase();
      const rel = state.relations?.[contact.counterpartTeam] ?? 50;
      // Friendly relationships almost always reply; hostile ones often don't.
      let pReply = 0.55 + (rel - 50) / 100; // 0.05 at rel=0, 1.05 at rel=100
      if (/(quiet|stoic|rigid|aloof|cold|harsh|toxic|brash)/.test(personality)) pReply -= 0.15;
      if (/(jolly|warm|chatty|friendly|polite|professional)/.test(personality)) pReply += 0.15;
      pReply = Math.max(0.1, Math.min(0.97, pReply + long));
      return Math.random() < pReply;
    }
    // Player on your own roster — usually replies to the gaffer, but a fragile
    // or red-carded player might sulk and say nothing.
    const p = state.teams[contact.counterpartTeam]?.players.find((x) => x.name === contact.counterpartName);
    const morale = p?.morale ?? 50;
    let pReply = 0.85 + (morale - 50) / 200;
    if (p?.suspensionWeeks && p.suspensionWeeks > 0) pReply -= 0.2;
    pReply = Math.max(0.25, Math.min(0.98, pReply + long));
    return Math.random() < pReply;
  }

  async function send() {
    if (!contact) return;
    const msg = input.trim();
    if (!msg || sending) return;
    setError(null);
    setSending(true);
    const myRow = await persist("user", msg);
    if (myRow) setRows((r) => [...r, myRow]);
    setInput("");

    // Team Channel broadcast — no AI reply, but the post nudges every player's
    // morale a little and the team morale more (public locker-room effect).
    if (contact.kind === "group") {
      try {
        const standingRow = standings.find((s) => s.team === contact.userTeam);
        const stand = standingRow ? `rank ${standingRow.rank}/${standings.length} (${standingRow.w}W ${standingRow.d}D ${standingRow.l}L)` : "unranked";
        const teamMorale = state.teams[contact.userTeam]?.morale ?? 50;
        const brief = `Your club ${contact.userTeam} is ${stand}. Current team morale ${teamMorale.toFixed(0)}/100.`;
        const res = await broadcastFn({
          data: {
            userTeam: contact.userTeam,
            userManagerName: state.managers?.[contact.userTeam]?.name ?? "Manager",
            brief,
            message: msg,
          },
        });
        const moraleMul = (state.settings?.pressInfluenceBaseline ?? 1) * (state.settings?.moraleVolatility ?? 1);
        const perPlayer = Math.round(res.tone * 1.0 * moraleMul);
        const teamDelta = Math.round(res.tone * 4 * moraleMul);
        const roster = state.teams[contact.userTeam]?.players ?? [];
        for (const p of roster) {
          if (perPlayer !== 0) applyPlayerMoraleDelta(contact.userTeam, p.name, perPlayer);
        }
        if (teamDelta !== 0) applyTeamMoraleDelta(contact.userTeam, teamDelta);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        reportAiOutcome(m);
        if (m.includes("CREDITS")) setError("AI credits exhausted. Add credits in Settings → Workspace → Usage.");
        // Don't surface a hard error for the broadcast — the post still landed.
      } finally { setSending(false); }
      return;
    }

    // Real-life async: sometimes nobody answers right away (or at all).
    if (!shouldReply(msg)) {
      setSending(false);
      toast(`${contact.counterpartName} hasn't replied yet…`, { description: "They may answer later — or not at all." });
      return;
    }

    try {
      let brief = "";
      let counterpartPersonality: string | undefined;
      if (contact.kind === "manager") {
        const ai = state.teams[contact.counterpartTeam];
        const standingRow = standings.find((s) => s.team === contact.counterpartTeam);
        const record = standingRow ? `${standingRow.w}W ${standingRow.d}D ${standingRow.l}L (rank ${standingRow.rank})` : "no data";
        const payroll = ai ? `$${ai.players.reduce((s, p) => s + (p.salary ?? 0), 0).toFixed(0)}M` : "?";
        brief = briefForManagerDm(contact.userTeam, contact.counterpartTeam, state.relations?.[contact.counterpartTeam], payroll, record)
          + recentPressFor(state.pressArchive, { userTeam: contact.userTeam, counterpartKind: "manager", counterpartTeam: contact.counterpartTeam, counterpartName: contact.counterpartName });
        counterpartPersonality = state.managers?.[contact.counterpartTeam]?.personality;
      } else {
        const p = state.teams[contact.counterpartTeam]?.players.find((x) => x.name === contact.counterpartName);
        if (!p) throw new Error("Player no longer on roster");
        const standingRow = standings.find((s) => s.team === contact.counterpartTeam);
        const stand = standingRow ? `rank ${standingRow.rank}/${standings.length}` : "unranked";
        brief = briefForPlayerDm(p, contact.counterpartTeam, stand)
          + recentPressFor(state.pressArchive, { userTeam: contact.userTeam, counterpartKind: "player", counterpartTeam: contact.counterpartTeam, counterpartName: contact.counterpartName });
      }
      const history: DmTurn[] = rows.map((r) => ({ role: r.role, text: r.content }));
      const res = await sendFn({
        data: {
          userTeam: contact.userTeam,
          userManagerName: state.managers?.[contact.userTeam]?.name ?? "Manager",
          kind: contact.kind,
          counterpartTeam: contact.counterpartTeam,
          counterpartName: contact.counterpartName,
          counterpartPersonality,
          brief,
          history,
          userMessage: msg,
        },
      });
      const reply = await persist("ai", res.reply);
      if (reply) setRows((r) => [...r, reply]);

      // Apply effects.
      const volMul = (state.settings?.relationsVolatility ?? 1);
      const moraleMul = (state.settings?.pressInfluenceBaseline ?? 1) * (state.settings?.moraleVolatility ?? 1);
      if (contact.kind === "manager") {
        applyRelationDelta(contact.counterpartTeam, res.userTone * 1.0 * volMul);
      } else {
        applyPlayerMoraleDelta(
          contact.counterpartTeam, contact.counterpartName,
          Math.round(res.userTone * 3 * moraleMul),
        );
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      reportAiOutcome(m);
      if (m.includes("RATE_LIMIT")) setError("They're slow to reply — try again in a moment.");
      else if (m.includes("CREDITS")) setError("AI credits exhausted. Add credits in Settings → Workspace → Usage.");
      else setError("Couldn't send. Please try again.");
    } finally { setSending(false); }
  }

  // Proactive DMs — once per game-week per user club, roll a small chance for
  // each AI manager / own player to text first. Strict cap (2 calls per scan)
  // keeps credit use near zero. Guarded by localStorage so opening the suite
  // multiple times in the same week never re-triggers.
  const proactiveDoneRef = useRef<string>("");
  useEffect(() => {
    if (!userTeam) return;
    const week = state.currentWeek ?? 0;
    const scanKey = `${userTeam}@${state.season ?? 1}.${week}`;
    if (proactiveDoneRef.current === scanKey) return;
    const storageKey = `dm-proactive-${userTeam}`;
    try {
      const last = typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
      if (last === scanKey) { proactiveDoneRef.current = scanKey; return; }
    } catch { /* ignore */ }
    proactiveDoneRef.current = scanKey;

    // Build candidate pool with per-contact probability.
    type Candidate = { contact: ContactKey; p: number; counterpartPersonality?: string };
    const pool: Candidate[] = [];
    for (const m of aiManagerContacts) {
      const personality = (m.personality ?? "").toLowerCase();
      const rel = state.relations?.[m.team] ?? 50;
      let p = 0.05;
      if (rel > 70 || rel < 30) p += 0.04; // strong feelings prompt outreach
      if (/(chatty|warm|jolly|theatrical|brash|loud)/.test(personality)) p += 0.03;
      if (/(quiet|stoic|aloof|cold)/.test(personality)) p -= 0.03;
      pool.push({
        contact: { userTeam, kind: "manager", counterpartTeam: m.team, counterpartName: m.name },
        p: Math.max(0, Math.min(0.2, p)),
        counterpartPersonality: m.personality,
      });
    }
    for (const p of ownPlayers) {
      const morale = p.morale ?? 50;
      let prob = 0.02;
      if (morale < 35 || morale > 80) prob += 0.04; // very unhappy or very happy
      if (p.injuryWeeks > 0) prob += 0.03;
      pool.push({
        contact: { userTeam, kind: "player", counterpartTeam: userTeam, counterpartName: p.name },
        p: Math.max(0, Math.min(0.15, prob)),
      });
    }

    // Roll dice and cap at 2 initiations per scan.
    const hits = pool.filter((c) => Math.random() < c.p).slice(0, 2);
    if (hits.length === 0) {
      try { window.localStorage.setItem(storageKey, scanKey); } catch { /* ignore */ }
      return;
    }

    void (async () => {
      for (const hit of hits) {
        try {
          let brief = ""; let counterpartPersonality = hit.counterpartPersonality;
          if (hit.contact.kind === "manager") {
            const ai = state.teams[hit.contact.counterpartTeam];
            const standingRow = standings.find((s) => s.team === hit.contact.counterpartTeam);
            const record = standingRow ? `${standingRow.w}W ${standingRow.d}D ${standingRow.l}L (rank ${standingRow.rank})` : "no data";
            const payroll = ai ? `$${ai.players.reduce((s, p) => s + (p.salary ?? 0), 0).toFixed(0)}M` : "?";
            brief = briefForManagerDm(hit.contact.userTeam, hit.contact.counterpartTeam, state.relations?.[hit.contact.counterpartTeam], payroll, record);
          } else {
            const pl = state.teams[hit.contact.counterpartTeam]?.players.find((x) => x.name === hit.contact.counterpartName);
            if (!pl) continue;
            const standingRow = standings.find((s) => s.team === hit.contact.counterpartTeam);
            const stand = standingRow ? `rank ${standingRow.rank}/${standings.length}` : "unranked";
            brief = briefForPlayerDm(pl, hit.contact.counterpartTeam, stand);
          }
          // Load existing history for the thread so the opener feels in-context.
          const { data: existing } = await supabase
            .from("manager_messages")
            .select("*")
            .eq("user_team", hit.contact.userTeam)
            .eq("counterpart_kind", hit.contact.kind)
            .eq("counterpart_team", hit.contact.counterpartTeam)
            .eq("counterpart_name", hit.contact.counterpartName)
            .order("created_at", { ascending: true });
          const prior = ((existing as unknown) as RawRow[]) ?? [];
          const history: DmTurn[] = prior.map((r) => ({ role: r.role, text: r.content }));
          const res = await sendFn({
            data: {
              userTeam: hit.contact.userTeam,
              userManagerName: state.managers?.[hit.contact.userTeam]?.name ?? "Manager",
              kind: hit.contact.kind,
              counterpartTeam: hit.contact.counterpartTeam,
              counterpartName: hit.contact.counterpartName,
              counterpartPersonality,
              brief,
              history,
              userMessage: "",
              initiate: true,
            },
          });
          // Persist as if the AI replied.
          const { data: inserted } = await supabase
            .from("manager_messages")
            .insert([{
              user_team: hit.contact.userTeam,
              counterpart_kind: hit.contact.kind,
              counterpart_team: hit.contact.counterpartTeam,
              counterpart_name: hit.contact.counterpartName,
              role: "ai",
              content: res.reply,
            } as never])
            .select()
            .maybeSingle();
          const row = (inserted as unknown) as RawRow | null;
          toast(`New DM from ${hit.contact.counterpartName}`, { description: res.reply.slice(0, 120) });
          // If this is the active thread, append it live.
          if (row && contact && keyOf(contact) === keyOf(hit.contact)) {
            setRows((r) => [...r, row]);
          }
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          reportAiOutcome(m);
          // Stop the scan if credits are gone — no point burning more calls.
          if (m.includes("CREDITS")) break;
        }
      }
      try { window.localStorage.setItem(storageKey, scanKey); } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userTeam, state.currentWeek, state.season]);

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      {/* Sidebar */}
      <aside className="space-y-3">
        <div>
          <label className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Your club</label>
          <Select value={userTeam} onValueChange={(v) => { setUserTeam(v); setContact(null); }}>
            <SelectTrigger className="w-full bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              {userTeams.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-xl border bg-card">
          <div className="border-b bg-panel px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Team Channel</div>
          <ul className="divide-y">
            {(() => {
              const k: ContactKey = { userTeam, kind: "group", counterpartTeam: userTeam, counterpartName: "Team Channel" };
              const active = contact && keyOf(contact) === keyOf(k);
              const tm = state.teams[userTeam]?.morale ?? 50;
              return (
                <li>
                  <button
                    onClick={() => setContact(k)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted ${active ? "bg-muted font-semibold" : ""}`}
                  >
                    <span className="truncate">📣 {userTeam} squad <span className="text-muted-foreground">· broadcast</span></span>
                    <span className="font-mono text-[10px] text-muted-foreground">{tm.toFixed(0)}</span>
                  </button>
                </li>
              );
            })()}
          </ul>
        </div>

        <div className="rounded-xl border bg-card">
          <div className="border-b bg-panel px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Managers</div>
          <ul className="max-h-64 divide-y overflow-y-auto">
            {aiManagerContacts.map((m) => {
              const k: ContactKey = { userTeam, kind: "manager", counterpartTeam: m.team, counterpartName: m.name };
              const active = contact && keyOf(contact) === keyOf(k);
              const rel = state.relations?.[m.team];
              return (
                <li key={m.team}>
                  <button
                    onClick={() => setContact(k)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted ${active ? "bg-muted font-semibold" : ""}`}
                  >
                  <span className="truncate">
                    {m.name} <span className="text-muted-foreground">· {m.team}</span>
                  </span>
                    <span className="font-mono text-[10px] text-muted-foreground">{typeof rel === "number" ? rel.toFixed(0) : "—"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="rounded-xl border bg-card">
          <div className="border-b bg-panel px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Your Players</div>
          <ul className="max-h-64 divide-y overflow-y-auto">
            {ownPlayers.map((p) => {
              const k: ContactKey = { userTeam, kind: "player", counterpartTeam: userTeam, counterpartName: p.name };
              const active = contact && keyOf(contact) === keyOf(k);
              return (
                <li key={p.name}>
                  <button
                    onClick={() => setContact(k)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted ${active ? "bg-muted font-semibold" : ""}`}
                  >
                  <span className="truncate">
                    {p.name} <span className="text-muted-foreground">· {p.position}</span>
                  </span>
                    <span className={`font-mono text-[10px] ${isPlayerOut(p) ? "text-highlight-red" : ""}`}>{(p.morale ?? 50).toFixed(0)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      {/* Thread */}
      <section className="rounded-xl border bg-card p-4">
        {!contact ? (
          <p className="text-sm text-muted-foreground">Pick a contact on the left to start a private conversation. Anything you say nudges that person's morale (players) or your relationship with them (managers) — there are no public consequences.</p>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-extrabold">{contact.counterpartName}</div>
                <div className="text-[11px] text-muted-foreground">
                  {contact.kind === "manager"
                    ? `Manager of ${contact.counterpartTeam}`
                    : contact.kind === "player"
                      ? `Your player on ${contact.counterpartTeam}`
                      : `Broadcast to the entire ${contact.counterpartTeam} squad — only you can post here`}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={deleteThread} className="text-destructive hover:text-destructive">CLEAR</Button>
            </div>
            <div ref={scrollRef} className="mb-3 max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {rows.length === 0 && <p className="text-xs text-muted-foreground">No messages yet — say hi.</p>}
              {rows.map((r) => {
                if (r.role === "press") {
                  return (
                    <div key={r.id} className="text-center">
                      <div className="inline-block max-w-[95%] whitespace-pre-wrap rounded-lg border-l-4 border-stadium-gold bg-card px-3 py-2 text-left text-[11px] text-muted-foreground">
                        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-stadium-gold">On the record</div>
                        {r.content}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={r.id} className={r.role === "user" ? "text-right" : "text-left"}>
                    <div className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${r.role === "user" ? "bg-highlight-blue/10 text-foreground" : "border bg-background text-foreground"}`}>
                      {r.content}
                    </div>
                  </div>
                );
              })}
              {sending && (
                <p className="text-xs text-muted-foreground">
                  {contact.kind === "group" ? "Squad is reading…" : `${contact.counterpartName} is typing…`}
                </p>
              )}
            </div>
            {error && <div className="mb-2 rounded-lg border-l-4 border-highlight-red bg-background px-3 py-2 text-xs">{error}</div>}
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={contact.kind === "group" ? "Broadcast to your squad…" : "Type a private message…"}
                className="bg-background"
                disabled={sending}
              />
              <Button onClick={send} disabled={sending || !input.trim()} className="font-semibold">
                {contact.kind === "group" ? "Post" : "Send"}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
