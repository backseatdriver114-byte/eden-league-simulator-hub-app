import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

// Lightweight cross-suite navigation. The Hub registers the ordered list of
// suite names; any suite can call goToSuite(name, payload) to jump to another
// suite and hand it a one-shot focus payload (e.g. preselect a club in the Team
// Editor, or seed a negotiation and return to the Draft Suite afterwards).

export interface NegotiationSeedPayload {
  proposalId?: string;
  userTeam: string;
  aiTeam: string;
  userSends: string[];
  aiSends: string[];
  cashUserReceives: number;
  cashAiReceives: number;
  userPicks?: string[];
  aiPicks?: string[];
}

export interface NavPayload {
  team?: string; // Team Editor: preselect this club
  player?: string; // Team Editor: highlight this player
  negotiationSeed?: NegotiationSeedPayload; // Negotiation: open this session
  returnSuite?: string; // suite to return to after the negotiation closes
}

interface NavContextValue {
  index: number;
  suiteName: string;
  setIndex: (i: number) => void;
  next: () => void;
  prev: () => void;
  goToSuite: (name: string, payload?: NavPayload) => void;
  consumePayload: () => NavPayload | null;
  peekPayload: () => NavPayload | null;
}

const NavContext = createContext<NavContextValue | null>(null);

export function NavigationProvider({
  suites,
  children,
}: {
  suites: string[];
  children: ReactNode;
}) {
  const [index, setIndexState] = useState(0);
  const payloadRef = useRef<NavPayload | null>(null);
  const [, force] = useState(0);

  const setIndex = useCallback((i: number) => {
    setIndexState(((i % suites.length) + suites.length) % suites.length);
  }, [suites.length]);

  const next = useCallback(() => setIndexState((i) => (i + 1) % suites.length), [suites.length]);
  const prev = useCallback(() => setIndexState((i) => (i - 1 + suites.length) % suites.length), [suites.length]);

  const goToSuite = useCallback((name: string, payload?: NavPayload) => {
    const idx = suites.indexOf(name);
    if (idx < 0) return;
    payloadRef.current = payload ?? null;
    setIndexState(idx);
    force((n) => n + 1);
  }, [suites]);

  const consumePayload = useCallback(() => {
    const p = payloadRef.current;
    payloadRef.current = null;
    return p;
  }, []);

  const peekPayload = useCallback(() => payloadRef.current, []);

  const value = useMemo<NavContextValue>(() => ({
    index,
    suiteName: suites[index],
    setIndex,
    next,
    prev,
    goToSuite,
    consumePayload,
    peekPayload,
  }), [index, suites, setIndex, next, prev, goToSuite, consumePayload, peekPayload]);

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNavigation(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNavigation must be used within NavigationProvider");
  return ctx;
}
