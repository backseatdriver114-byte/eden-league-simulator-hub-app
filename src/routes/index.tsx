import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { LeagueProvider, useLeague } from "@/state/league";
import { SimulationTerminal } from "@/components/SimulationTerminal";
import { ScheduleSuite } from "@/components/ScheduleSuite";
import { StandingsSuite } from "@/components/StandingsSuite";
import { TeamEditorSuite } from "@/components/TeamEditorSuite";
import { PlayoffsSuite } from "@/components/PlayoffsSuite";
import { MatchSchedulingSuite } from "@/components/MatchSchedulingSuite";
import { TradesSuite } from "@/components/TradesSuite";
import { ContractsSuite } from "@/components/ContractsSuite";
import { SettingsSuite } from "@/components/SettingsSuite";
import { SaveVersionButton } from "@/components/SaveVersionButton";
import { NotificationCenter } from "@/components/NotificationCenter";
import { NewsSuite } from "@/components/NewsSuite";
import { NegotiationSuite } from "@/components/NegotiationSuite";
import { DraftSuite } from "@/components/DraftSuite";
import { MessagesSuite } from "@/components/MessagesSuite";
import { ManagerGenerationWatcher } from "@/components/ManagerGenerationWatcher";
import { AiPressConferenceWatcher } from "@/components/AiPressConferenceWatcher";
import { NewsAutogenWatcher } from "@/components/NewsAutogenWatcher";
import { AiProviderSyncer } from "@/components/AiProviderSyncer";
import { TrophyRoomSuite } from "@/components/TrophyRoomSuite";
import { NavigationProvider, useNavigation } from "@/state/navigation";
import { downloadLeagueExport, restoreManagerMessages, type ManagerMessageRow } from "@/lib/league-export";
import { Button } from "@/components/ui/button";
import edenLogo from "@/assets/eden-league-logo.svg";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Eden League Data Hub" },
      { name: "description", content: "Central database, simulation engine, standings and roster control center for the 24-team Eden League." },
      { property: "og:title", content: "Eden League Data Hub" },
      { property: "og:description", content: "Simulation terminal, schedule, live standings and roster editor for the Eden League." },
    ],
  }),
  component: () => (
    <LeagueProvider>
      <NavigationProvider suites={SUITES.map((s) => s.name)}>
        <Hub />
      </NavigationProvider>
    </LeagueProvider>
  ),
});

const SUITES = [
  { name: "Season Schedule", render: () => <ScheduleSuite /> },
  { name: "League Standings", render: () => <StandingsSuite /> },
  { name: "Team Editor", render: () => <TeamEditorSuite /> },
  { name: "Trades", render: () => <TradesSuite /> },
  { name: "Negotiation", render: () => <NegotiationSuite /> },
  { name: "Simulation Terminal", render: () => <SimulationTerminal /> },
  { name: "Newsroom", render: () => <NewsSuite /> },
  { name: "Messages", render: () => <MessagesSuite /> },
  { name: "Playoffs", render: () => <PlayoffsSuite /> },
  { name: "Match Scheduling", render: () => <MatchSchedulingSuite /> },
  { name: "Contracts", render: () => <ContractsSuite /> },
  { name: "Draft", render: () => <DraftSuite /> },
  { name: "Settings & Version Archives", render: () => <SettingsSuite /> },
];

function Hub() {
  const { index: idx, next, prev } = useNavigation();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="min-h-screen">
      <ManagerGenerationWatcher />
      <AiPressConferenceWatcher />
      <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur">
        <div className="h-1 w-full" style={{ backgroundImage: "var(--gradient-rb)" }} />
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="relative flex items-center gap-2">
            <button
              onClick={prev}
              aria-label="Previous suite"
              className="ml-auto select-none px-3 py-1 text-2xl font-bold text-highlight-blue transition-colors hover:opacity-70"
            >
              ‹
            </button>
            <div className="flex flex-col items-center text-center">
              <div className="flex items-center gap-2">
                <img src={edenLogo} alt="Eden League crest" className="h-8 w-8 object-contain" />
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  Eden League Data Hub
                </div>
              </div>
              <h1 className="text-lg font-extrabold tracking-tight sm:text-xl">
                {SUITES[idx].name}
              </h1>
            </div>
            <button
              onClick={next}
              aria-label="Next suite"
              className="mr-auto select-none px-3 py-1 text-2xl font-bold text-highlight-red transition-colors hover:opacity-70"
            >
              ›
            </button>
            <div className="absolute right-0 top-1/2 -translate-y-1/2">
              <NotificationCenter />
            </div>
          </div>
          <Toolbar />
        </div>
      </header>


      <main className="mx-auto max-w-6xl px-4 py-6">
        {mounted ? SUITES[idx].render() : (
          <div className="py-20 text-center text-sm text-muted-foreground">Loading league state…</div>
        )}
      </main>
    </div>
  );
}

function Toolbar() {
  const { undo, redo, canUndo, canRedo, state, standings, leaderboards, importLeagueExport } = useLeague();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const ok = window.confirm(
      `Import "${file.name}"?\n\nThis REPLACES the current league (teams, rosters, schedule, results, standings, managers, relations, settings, DM history) with the contents of the file. You can ↶ UNDO the league-state part immediately after if it looks wrong.`
    );
    if (!ok) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result ?? "")) as Record<string, unknown>;
        const res = importLeagueExport(parsed);
        if (!res.ok) { window.alert(`Import failed: ${res.error}`); return; }
        // Restore the Cloud-only DM history (lives outside LeagueState).
        const msgs = Array.isArray(parsed.messages) ? (parsed.messages as ManagerMessageRow[]) : [];
        void restoreManagerMessages(msgs).catch((err) => {
          console.warn("[import] DM restore failed", err);
        });
      } catch (err) {
        window.alert(`Could not parse JSON: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    };
    reader.onerror = () => window.alert("Could not read the file.");
    reader.readAsText(file);
  };
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
      <Button size="sm" variant="outline" onClick={undo} disabled={!canUndo}
        title="Undo the last action across any suite" className="font-semibold">
        ↶ UNDO
      </Button>
      <Button size="sm" variant="outline" onClick={redo} disabled={!canRedo}
        title="Redo the last undone action" className="font-semibold">
        ↷ REDO
      </Button>
      <SaveVersionButton />
      <Button
        size="sm"
        variant="outline"
        onClick={() => { void downloadLeagueExport(state, standings, leaderboards); }}
        title="Download all league data as a JSON file (includes DM history, manager respect, relations and settings)"
        className="font-semibold"
      >
        ⬇ EXPORT LEAGUE DATA
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => fileRef.current?.click()}
        title="Restore league data from an exported JSON file (replaces current league)"
        className="font-semibold"
      >
        ⬆ IMPORT LEAGUE DATA
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onPickFile}
      />
    </div>
  );
}
