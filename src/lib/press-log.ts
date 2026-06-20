// Persist a press-conference exchange into every relevant DM thread so the
// mentioned managers and players "remember" the exact words the user said on
// the record. The DM AI then sees these press quotes in its history when the
// rival or player replies, and can clap back / praise / sulk accordingly.
import { supabase } from "@/integrations/supabase/client";
import type { PressContext, PressTarget } from "./press-conference.functions";

interface LogArgs {
  userTeam: string;
  managerName: string;
  context: PressContext;
  question: string;
  answer: string;
  targets: PressTarget[];
  // Resolver: team -> AI manager name (returns null for user-controlled clubs
  // or missing managers, so we skip logging into nonexistent threads).
  aiManagerNameFor: (team: string) => string | null;
  // The user-controlled team set, so press hits on another user club don't
  // create cross-user DM threads.
  isUserTeam: (team: string) => boolean;
}

export async function logPressTargets(args: LogArgs): Promise<void> {
  const ctx = args.context === "pre" ? "pre-match" : args.context === "post" ? "post-match" : "general";
  const body = [
    `[PRESS — ${ctx} — ${args.managerName} of ${args.userTeam}]`,
    `Q: ${args.question}`,
    `A: ${args.answer}`,
  ].join("\n");

  type Row = {
    user_team: string;
    counterpart_kind: "manager" | "player";
    counterpart_team: string;
    counterpart_name: string;
    role: "press";
    content: string;
  };
  const rows: Row[] = [];
  const seen = new Set<string>();
  function add(kind: "manager" | "player", counterpartTeam: string, counterpartName: string) {
    const k = `${kind}|${counterpartTeam}|${counterpartName}`;
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({
      user_team: args.userTeam,
      counterpart_kind: kind,
      counterpart_team: counterpartTeam,
      counterpart_name: counterpartName,
      role: "press",
      content: body,
    });
  }

  for (const t of args.targets) {
    if (t.kind === "manager") {
      if (t.team === args.userTeam || args.isUserTeam(t.team)) continue;
      const name = args.aiManagerNameFor(t.team);
      if (!name) continue;
      add("manager", t.team, name);
    } else if (t.kind === "player") {
      if (t.team === args.userTeam) {
        // Own player — they hear it through their own DM thread.
        add("player", args.userTeam, t.name);
      } else if (!args.isUserTeam(t.team)) {
        // Rival player — route it through the rival manager's thread so the
        // club knows the user spoke about their player on TV.
        const name = args.aiManagerNameFor(t.team);
        if (!name) continue;
        add("manager", t.team, name);
      }
    } else if (t.kind === "team") {
      if (t.name === args.userTeam || args.isUserTeam(t.name)) continue;
      const name = args.aiManagerNameFor(t.name);
      if (!name) continue;
      add("manager", t.name, name);
    }
  }

  if (rows.length === 0) return;
  const { error } = await supabase.from("manager_messages").insert(rows as never);
  if (error) console.warn("[press-log] insert failed", error.message);
}