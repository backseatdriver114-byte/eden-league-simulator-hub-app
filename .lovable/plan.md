
Nine changes across state, engines, and UI. Grouping by area to keep edits contained.

## 1. Full reset when a user manager is "fired"

Add `fireAndHireManager(team, newName, newPersonality?)` mutator in `src/state/league.tsx` that, for the given team, resets:
- `managers[team]` → new name + `USER CONTROLLED` personality (always)
- `relations[team]` → `settings.relationsBaseline`
- `respect[team]` → 50 (baseline)
- `morale[team]` → `settings.moraleBaseline`
- Player morale for that team's roster → baseline
- Deletes all `manager_messages` rows where `user_team = team`
- Purges `pressArchive` entries where `team === team`
- Purges `articleArchive` entries mentioning old manager
- Appends a public "league news" record (title: "{Team} fires manager, hires {New}") that press conferences + DM briefs can pick up (added to `pressArchive` as a synthetic event? — simpler: push to `state.leagueEvents` new slice, capped 100, read into `buildPressBrief` and `buildLeagueContext`).

## 2. Split volatility: add `pressConferenceVolatility`

- `engine-settings.ts`: add `pressConferenceVolatility: number` (default 1.0, range 0.1–3.0 shown as slider). Keep `managerRatingVolatility` as-is for match/standings drift.
- `press-conference.functions.ts`: multiply every `respectDelta` and `relationDelta` by `settings.pressConferenceVolatility` (in addition to any existing multipliers). Base range stays ±15, but is scaled here.
- `SettingsSuite.tsx`: add slider (0.1–3.0, step 0.1) labeled "Press Conference Volatility".

## 3. Weight standings/match results heavier in `managerRatingVolatility`

In whatever engine drifts respect on match results / weekly (search for `respect` writes in engine tick + season-end), multiply the respect change by `settings.managerRatingVolatility * 2.5` where the source is match result or standings position (top-4 boost, bottom-4 penalty scales with rank). Reduce weight of non-match respect drift so relative weighting shifts toward on-pitch results.

## 4. Rename Team Editor button → "FIRE MANAGER AND HIRE NEW"

`TeamEditorSuite.tsx`:
- Rename the save button.
- On click: confirm dialog, then call `fireAndHireManager(...)`.
- Also push a league event (see #1) so it becomes public knowledge.

## 5. Media Article Archive

- Add `articleArchive: ArticleArchiveEntry[]` to `LeagueState` (capped 500). Entry: `{ id, season, week, title, body, kind, mentions[], createdAt }`.
- Every place that generates a news article (news.functions / news-brief consumers in `NewsSuite.tsx`) — append to archive after generation.
- Add "📰 View Article Archive" + "Clear All Articles" buttons in NewsSuite, mirroring press archive UI. Reuse a new `ArticleArchiveDialog.tsx` component (same 2-level browse: week → article).

## 6. Tempo slider 0.1–2.0

- SettingsSuite: replace the 3-option Slow/Normal/Fast control with a slider (`min=0.1`, `max=2.0`, `step=0.1`). Keep `settings.defaultTempo` numeric — engine already multiplies by it. Show current value inline (e.g. "Tempo: 1.20").

## 7. AI-driven sacking

- Replace algorithmic `morale < sackThreshold` check with a weekly `evaluateAiSackings` server function (new `src/lib/sacking.functions.ts`) that takes a compact brief of each AI team's:
  - Manager respect rating (heavy weight)
  - Team morale (medium)
  - Standings position + record (heavy)
  - Recent press mentions of manager (light)
  - Average player morale (light)
  - Weeks in job / current season week (context)
- Returns `{ team, sack: boolean, reason: string }[]`. Applied via existing sack routine (which triggers `ManagerGenerationWatcher`).
- Wire into existing weekly tick (currently in engine advance / week-end effect). Keep `sackThreshold` in Settings but reframed as a "hint" the AI sees, not an auto-trigger.

## 8. User-controlled personality (non-editable, derived)

- `TeamEditorSuite.tsx`: for user-controlled teams, personality field becomes read-only with label "Derived from your activity".
- Add `deriveUserPersonality(state, team): string` in `src/lib/user-personality.ts` — synthesizes a short paragraph from:
  - Press archive entries by that team (heaviest weight)
  - DM outgoing messages (medium)
  - Trade behavior aggression (light)
  - Recent press angles / tone words
  It runs on demand (cached in state as `derivedPersonalities[team]`) via a lightweight AI call (`generateDerivedPersonality` server fn) refreshed weekly.
- Use it wherever AI managers read personality (negotiation brief, DM brief, press brief). Instead of `USER CONTROLLED`, when the reader is an AI reasoning about a user manager, they see the derived personality.
- In DM + press briefs, append a "TONE BLEND" line: "Consider the opposing manager's personality lightly (weight ~10-15%) when picking words." Include the counterpart's personality in the prompt with an explicit "MINOR influence" caveat.

## 9. Formation-aware auto-fill

Rewrite the auto-fill in `src/lib/lineup.ts`:
1. Parse formation into slot list, each slot tagged with primary + acceptable positions (e.g. attacking wing slot → primary `LW/RW/W`, acceptable `AM/ST`).
2. Take the current starting XI (or top-11 by rating if none).
3. Detect slots unchanged from previous formation and lock those players first (position parity check).
4. For remaining slots, build a cost matrix (Hungarian / greedy: cost = distance between player's natural position and slot's primary, with heavy penalty for wrong line — GK, DEF, MID, FW).
5. Assign to minimize total cost.

Example (3-4-1 → 3-2-3): back 3 slots unchanged → locked. Center-mid slots identical → locked. Outside mids move to wing slots (natural position `W/LW/RW` still preferred over striker). Solo attacker → central attacking slot.

## Technical notes

- New state slices (`articleArchive`, `leagueEvents`, `derivedPersonalities`) get default `[]`/`{}` in `normalizeState` so old saves load cleanly. Export/import already whole-state, so they ride along automatically.
- Settings changes: bump `EngineSettings` interface + `DEFAULT_SETTINGS`; `applySettings` merge covers old saves.
- No new DB tables — everything lives in `league_state.data` JSON.
- All new AI server fns share the existing `ai-fallback` provider chain.

## Order of implementation

1. State + settings additions (foundation for everything else).
2. Fire-and-hire mutator + Team Editor rename + confirm.
3. Press volatility scaling + settings slider + tempo slider.
4. Match/standings respect weighting.
5. Article archive (state + generator hooks + dialog + clear).
6. AI sacking function + wire-in.
7. Derived user personality + tone-blend prompt updates.
8. Formation-aware auto-fill.
