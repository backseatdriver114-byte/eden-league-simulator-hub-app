## Scope

Building today, from your picks:

1. **Logos + colors everywhere teams appear**
2. **Medium team-color theming** (row/card tints, primary borders)
3. **Better League Table** — Form (last 5 W/D/L pills), Streak, GD color
4. **Team Editor redesign** — Club Info card + roster/stats panels
5. **Trophy Room / League History** (backfilled from existing state) — Champions, Golden Boot/Glove, MVP, per-club trophy case
6. **News auto-gen** — match results, streaks, standings shifts, trades/sackings — with **frequency slider** in Settings
7. **AI model selector** — hard-pinned (no fallback), locked options for missing keys / credit-exhausted / rate-limited providers

Explicitly **not** in scope: Stats Center, Dashboard landing, Season timeline, dynamic stadiums, honors/mascots/rivalries, xG, VAR, and anything else needing data you haven't provided.

---

## Implementation

### 1. Badges everywhere

Drop `<TeamBadge>` into every remaining team-name site:

- `ScheduleSuite`, `MatchSchedulingSuite`, `PlayoffsSuite`, `TradesSuite`, `ContractsSuite`, `NegotiationSuite`, `MessagesSuite`, `NewsSuite`, `SimulationTerminal` scoreline, `PlayerSearch` result rows, `TeamEditorSuite` header.
- Consistent sizes: 20px inline lists, 28px cards, 48px team-page hero.

### 2. Medium team-color theming

Extend `TeamBadge` behavior via a new `<TeamRow>` wrapper that applies:

- `border-left: 3px solid var(--team-primary)`
- `background: color-mix(in oklab, var(--team-primary) 8%, transparent)` on hover / active
- Used in standings rows, schedule slots, roster tables, trade/negotiation cards.

Match slots in `MatchSchedulingSuite` and Simulation Terminal show both clubs' primary colors as a thin split accent bar (top edge).

### 3. Better League Table

`StandingsSuite`: add three columns:

- **Form**: 5 small pills (green W, gray D, red L) from last 5 completed matches per team.
- **Streak**: e.g. `W3`, `L2`, `D1`, colored.
- **GD**: text color scaled green→red by value.

Make sure team colors are implemented here heavily, the team slots should be in team colors.

### 4. Team Editor redesign

`TeamEditorSuite`: reorganize into a **Club Info card** (logo picker, 3 hex colors, name, manager, description text field added to `LeagueTeam`) + existing **Roster** + **Quick Stats** side panels (record, top scorer, form, next fixture — pulled from state). No new engine data.

### 5. Trophy Room + League History

- Extend state with `history: { seasons: SeasonRecord[] }` where `SeasonRecord = { season, champion, runnerUp, finalFour, goldenBoot: {player, team, goals}, goldenGlove: {player, team, ga}, mvp: {player, team, score} }`.
- **Backfill**: on load, if `history` empty, derive whatever we can from current completed weeks (current-season standings + player stats become the "in-progress" record shown, and any prior season data already in state is carried forward).
- Hook season-end (existing playoffs completion path) to append a `SeasonRecord`.
- New **Trophy Room suite** slotted into the existing left/right suite navigator:
  - Top: season champions timeline
  - Middle: award winners per season
  - Bottom: per-club trophy case grid (24 cards, each showing that club's titles + years).

### 6. News auto-gen + frequency slider

- New module `src/lib/news-autogen.ts` with event detectors called from existing simulation and state mutators:
  - `onMatchComplete` → chance-based article for upsets (rating gap ≥ threshold), 3+ goal wins, comebacks
  - `onStandingsUpdate` → new leader / cutoff crossings
  - `onStreakUpdate` → win streak ≥ 3, unbeaten ≥ 5
  - `onTradeCompleted`, `onManagerFired` → always emit
- Each detector rolls against `settings.newsFrequency` (0..1). At 0, no auto-articles; at 1, every eligible event.
- Uses existing `news.functions.ts` AI pipeline; articles land in `NewsSuite`.
- Add slider `NEWS ARTICLE FREQUENCY` to `SettingsSuite` (0–100%, default 50%).

### 7. AI model selector (hard-pinned)

- Add `settings.aiModel: { chatModel, structuredModel }` with a curated allowlist of Lovable AI Gateway models (`google/gemini-3-flash-preview`, `google/gemini-2.5-flash`, `google/gemini-2.5-pro`, `openai/gpt-5-mini`, `openai/gpt-5`).
- Refactor `src/lib/ai-fallback.server.ts` → `ai.server.ts`:
  - **Hard-pin**: only call the selected model; on 402/429/5xx, return a typed error to the client, do NOT fall back.
  - Preserve current CONTENT_POLICY system-message injection.
- New `getAiStatus` server fn that returns per-model availability: `{ hasKey, lastError, cooldownUntil }`. Cooldown lives in-memory (~10 min) after a 402/429.
- New **AI Model** panel in `SettingsSuite`: dropdown (or radio list) of allowed models; each row shows a status badge (`READY`, `NO KEY`, `RATE LIMITED — retry in Xm`, `CREDITS EXHAUSTED`). Unavailable options are disabled.
- Client polls `getAiStatus` every 60s while the Settings panel is open, and after any AI call that errors.

---

## Technical notes

- All new state fields (`description`, `history`, `settings.newsFrequency`, `settings.aiModel`) are additive — existing saves keep working via defaults in the state loader.
- `TeamRow` and Form/Streak helpers live in `src/lib/team-stats.ts` (pure functions over `state.results`).
- News auto-gen hooks into existing mutators via a small event bus in `state/league.tsx` — no engine math changes (golden rule preserved).
- Model selector is UI + server-fn wiring only; no engine coupling.