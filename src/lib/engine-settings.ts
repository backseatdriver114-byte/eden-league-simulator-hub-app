// Central, editable engine settings ("tuning knobs"). Every engine reads from
// the live `settings` singleton at call time, so changing a value here (via the
// Settings suite) immediately changes simulation, contract, trade and morale
// behaviour without touching the ported math. Structural facts (team count,
// season length, formation, playoff seeding) are intentionally NOT here — they
// stay fixed in the engine/league code.

export interface EngineSettings {
  // ---- Simulation engine ----
  manualSimTeams: string[];      // clubs whose matches are entered manually (never simulated)
  defaultTempo: number;          // 1.0 slow / 1.2 normal / 1.4 fast
  goalMultiplier: number;        // global scoring multiplier
  identityBoostWeight: number;   // bonus for a club's favoured tactical style
  dynamicTactics: boolean;       // live in-match tactical shifts
  weatherEffects: boolean;       // randomized weather modifiers
  playoffPenalties: boolean;     // drawn playoff ties go to a shootout
  blowoutThreshold: number;      // goal margin at which the blowout dampener activates (>= this many goals)
  blowoutDecay: number;          // steepness exponent for the EXPONENTIAL blowout dampener (higher = harsher per-goal suppression; 0 = off)
  parityMultiplier: number;      // scales how much raw player attributes matter (1.0 = normal, <1 = closer games, >1 = wider gaps)

  // ---- Contract engine ----
  demandModifierMin: number;     // lower clamp on player wage demand modifier
  demandModifierMax: number;     // upper clamp on player wage demand modifier
  veteranPaycut: number;         // fraction shaved off a veteran's demand (0.15 = 15%)
  contractExemptTeams: string[]; // clubs the auto contract engine never touches

  // ---- Trade engine ----
  utilityThreshold: number;      // min combined ΔU for an auto proposal to surface
  transferWindowLastWeek: number;// last week the auto trade engine runs
  cashUtilityWeight: number;     // how much a club values cash ($M) in squad utility
  benchRatingWeight: number;     // how much bench depth counts in squad utility

  // ---- Morale engine ----
  moraleBaseline: number;        // neutral morale value
  highMorale: number;            // "buoyant" band threshold
  lowMorale: number;             // "fragile" band threshold
  sackThreshold: number;         // morale below this sacks the manager
  managerRenewalMorale: number;  // morale reset after a sacking
  seasonMoraleReset: number;     // points morale regresses toward baseline each season
  moraleVolatility: number;      // multiplier on NON-match morale swings (offseason, trades, sackings, weekly bench/starter drift)
  moraleMatchResultVolatility: number; // multiplier on morale swings caused by MATCH RESULTS only (win/loss/draw, goals, cards, injuries)

  // ---- Manager Relations / Press / Influence ----
  relationsBaseline: number;     // starting relationship value when no history exists (0-100)
  relationsVolatility: number;   // multiplier on every relationship swing
  pressInfluenceBaseline: number; // baseline multiplier on press / DM word-impact (1.0 = engine default)
  managerRatingVolatility: number; // multiplier on standings / drift / weekly noise only
  managerMatchResultVolatility: number; // separate multiplier on per-MATCH manager respect swings (win/loss margin, opponent quality, streaks)
  pressConferenceVolatility: number; // SEPARATE multiplier applied to respectDelta from press conferences only
  standingsWeight: number; // extra weight applied to the standings pull in weekly respect drift (>=1 amplifies)

  // ---- Newsroom (auto-generated articles) ----
  newsFrequency: number; // 0..1 — probability an eligible event spawns an auto-generated article

  // ---- AI provider selection ----
  aiProvider: "auto" | "lovable" | "gemini" | "openrouter" | "groq" | "mistral"; // hard-pin choice; "auto" = fallback chain
}

export const DEFAULT_SETTINGS: EngineSettings = {
  manualSimTeams: ["Socks", "Gugu Team", "Spams"],
  defaultTempo: 1.2,
  goalMultiplier: 0.6,
  identityBoostWeight: 0.6,
  dynamicTactics: true,
  weatherEffects: true,
  playoffPenalties: true,
  blowoutThreshold: 3,
  blowoutDecay: 0.6,
  parityMultiplier: 1.0,

  demandModifierMin: 0.8,
  demandModifierMax: 1.4,
  veteranPaycut: 0.15,
  contractExemptTeams: ["Gugu Team", "Spams"],

  utilityThreshold: 4.0,
  transferWindowLastWeek: 12,
  cashUtilityWeight: 0.25,
  benchRatingWeight: 0.4,

  moraleBaseline: 50,
  highMorale: 75,
  lowMorale: 35,
  sackThreshold: 25,
  managerRenewalMorale: 60,
  seasonMoraleReset: 7,
  moraleVolatility: 1.0,
  moraleMatchResultVolatility: 1.0,

  relationsBaseline: 50,
  relationsVolatility: 1.0,
  pressInfluenceBaseline: 1.0,
  managerRatingVolatility: 1.0,
  managerMatchResultVolatility: 1.0,
  pressConferenceVolatility: 1.5,
  standingsWeight: 2.2,

  newsFrequency: 0.5,
  aiProvider: "auto",
};

// Live, mutable singleton every engine reads from.
export const settings: EngineSettings = { ...DEFAULT_SETTINGS };

// Merge persisted settings into the live singleton (missing keys fall back to
// defaults). Called whenever league state is loaded/normalized or edited.
export function applySettings(partial?: Partial<EngineSettings>): EngineSettings {
  Object.assign(settings, DEFAULT_SETTINGS, partial ?? {});
  // Defensive: never allow a non-array list to slip through.
  if (!Array.isArray(settings.contractExemptTeams)) {
    settings.contractExemptTeams = [...DEFAULT_SETTINGS.contractExemptTeams];
  }
  if (!Array.isArray(settings.manualSimTeams)) {
    settings.manualSimTeams = [...DEFAULT_SETTINGS.manualSimTeams];
  }
  // Defensive: a blanked/garbled numeric knob (NaN/Infinity from a form field)
  // would poison every engine that multiplies by it — fall back to the default.
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof EngineSettings)[]) {
    if (typeof DEFAULT_SETTINGS[key] === "number" && !Number.isFinite(settings[key] as number)) {
      (settings[key] as number) = DEFAULT_SETTINGS[key] as number;
    }
  }
  return settings;
}

// Read a fresh copy (e.g. to seed editable form state / persist into LeagueState).
export function getSettings(): EngineSettings {
  return {
    ...settings,
    contractExemptTeams: [...settings.contractExemptTeams],
    manualSimTeams: [...settings.manualSimTeams],
  };
}

// Live exempt-club check used across contract code & UI.
export function isContractExempt(name: string): boolean {
  return settings.contractExemptTeams.includes(name);
}

// Live check: is this club's match entered manually (never simulated)?
export function isManualSimTeam(name: string): boolean {
  return settings.manualSimTeams.includes(name);
}
