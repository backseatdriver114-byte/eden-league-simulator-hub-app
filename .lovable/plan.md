
# Daily Timeline Redesign — Implementation Plan

## 1. Time system (day-of-week for every fixture)

State: extend `FixtureEntry` with `day: "MON"|"WED"|"FRI"|"SAT"`. Add `state.currentDay` alongside `state.currentWeek`. Advance day-by-day; a week rolls over when SAT finishes.

Backfill migration in `state/league.tsx` normalizer: for any existing fixture missing `day`, randomly distribute per-week into the 2/0/3/0/1/6/0 quota; Friday slot chosen by **closest-in-standings, highest-in-table** heuristic (fallback: highest combined team OVR when standings are empty).

Quota validator (2 MON, 3 WED, 1 FRI, 6 SAT) shared by:
- Match Scheduling builder — new day dropdown per fixture (Mon/Wed/Fri/Sat only). Save button disabled with a per-day counter chip when a day is over-full, same UX as the current 12-per-week check.
- Any state mutator that adds fixtures.

## 2. Suite reordering + merges + renames

New nav order in `src/state/navigation.tsx`:
Season Schedule → Standings → Team Editor → Newsroom → Messages → Negotiation → Trades → Simulation Terminal → Contracts → Match Scheduling → Draft → League History → Settings.

- **Playoffs suite removed** as a standalone. `ScheduleSuite` renders `PlayoffsSuite` content when `state.currentWeek >= 17` (post Final-Four); Final Four itself stays inside Schedule as today. The two files stay, but only Schedule is registered in nav.
- **Trophy Room → League History**. Owns: existing trophy content + season-end auto SAVE VERSION + AI season-summary + the **version archive list** moved out of Settings.
- **Settings & Version Archives → Settings** (archive UI/state moves to League History; the manual SAVE VERSION button in the header stays).

## 3. Season Schedule visuals

Each fixture row rendered as two 50/50 halves tinted with each club's primary color (mirrors the Standings row treatment, medium intensity). Day label chip on the left of each row grouped under a `MON / WED / FRI / SAT` sub-header within each week block.

## 4. Newsroom — daily press-conference windows

`press-conference.functions.ts` gate:
- Pre-match: available on `day-before` and `day-of` (same week only), disappears once attended or match played.
- Post-match: available on `day-of` only after the result is logged.
- New auto-generated **weekly roundup article** triggered when SAT of a week ends (routed through existing `news.functions.ts` + `NewsAutogenWatcher`).

Tone fix in `press-brief.ts`: rewrite the question-mix instructions to require a bull/bear/neutral spread (roughly 30/40/30) instead of only critical framings.

**Manager-name freshness fix**: `press-brief.ts` and `negotiation-brief.ts` now inject a `CURRENT REALITY` block sourced live from Team Editor (current manager name, current roster, current record) and instruct the model: past information is historical context only; the Team Editor snapshot is ground truth for names/roles/rosters. Same block also appended to `news-brief.ts`.

**No-stats acknowledgement**: `press-brief.ts` adds an explicit note — "This club logs results manually; per-player goals/assists/saves are intentionally absent. Do not press the user on missing box-score stats; treat aggregate results as the record of record."

## 5. Trades — behind-the-scenes GM negotiation

Replace the accept/decline coin-flip in `trade-ai.functions.ts` with a private negotiation loop (silent, no UI, no press): iterate 3–6 offer/counter rounds using the existing agent-negotiation scoring adapted to team needs (positional gap, budget, OVR delta). Only when both sides converge does a proposal surface in the Trades suite for user finalize/veto. If they diverge, nothing surfaces.

## 6. Engine v8 — BCO (Ball Control)

- Extend `LeaguePlayer` with `BCO: number`.
- Migration: for every existing player, `BCO = round(rating)` (state normalizer).
- UI: add BCO input to Team Editor player rows AND Draft prospect rows.
- Ratings: leave `computeOverall` weights alone for now (BCO not in weight maps unless user asks) — user said "we'll edit manually from there".
- Sim engine bridge (`src/engine/engine.ts`): pass BCO through wherever attributes are serialized; port v8 usages of BCO from the uploaded Python (dribble/turnover/carry checks) line-for-line.

## 7. Transfer window enforcement

`SettingsSuite` slider already stores `transferWindowWeek`. Add a shared `isTransferWindowOpen(state, settings)` helper (`currentWeek <= transferWindowWeek`). Gate at the mutator layer in `state/league.tsx` — every trade-accept, contract-sign, and free-agent-sign path checks this and no-ops with a toast when closed. UI buttons disable + show reason.

## 8. Match-result-driven volatility

Add two new sliders (default 0.5):
- Manager & Influence → **Match Result Volatility** (`matchResultManagerVolatility`).
- Morale → **Match Result Volatility** (`matchResultMoraleVolatility`).

Existing `Manager Rating Volatility` and `Morale Volatility` now cover only non-result drivers (standings/media/staff churn).

New hook fired from `setResult`:
```
adjustManagerRespect({goalMargin, oppTeamRating, oppStandingsRank,
                      streakBrokenOrExtended, mediaPressure})
adjustMorale(sameInputsPerPlayer + team)
```
Magnitude = base * matchResultXxxVolatility. Formula outline (documented in `morale.ts`):
`delta = sign(margin) * (|margin| * 0.6 + oppStrength * 0.4 + streakBonus) * volatility`
where `oppStrength = normalize(rank_gap + rating_gap)` and `streakBonus = ±1` when a streak is broken/extended. So a top-of-table manager can still gain respect via lopsided wins over strong opponents.

## 9. Auto SAVE VERSION at season end

In the playoffs-final resolver, after champion is set: enqueue `saveVersion({label: \`Season ${state.season} Final\`, auto: true})` before rolling into offseason. Archive list rendered in League History suite (same UI moved from Settings).

## 10. Files touched

**New**: `src/lib/day-schedule.ts` (quota/validator/Friday-picker), `src/lib/match-result-effects.ts`.
**Edited**: `state/league.tsx`, `engine/engine.ts`, `data/rosters.ts` (BCO seed), `state/navigation.tsx`, `components/ScheduleSuite.tsx`, `components/MatchSchedulingSuite.tsx`, `components/FixtureBuilder.tsx`, `components/TeamEditorSuite.tsx`, `components/DraftSuite.tsx`, `components/SettingsSuite.tsx`, `components/TrophyRoomSuite.tsx` (→ rename export to LeagueHistorySuite), `components/PlayoffsSuite.tsx` (embed target), `components/NewsAutogenWatcher.tsx` (weekly roundup + day gates), `lib/press-brief.ts`, `lib/news-brief.ts`, `lib/negotiation-brief.ts`, `lib/press-conference.functions.ts`, `lib/trade-ai.functions.ts`, `lib/morale.ts`, `lib/engine-settings.ts`.

## Out of scope (per user)

Standings, Team Editor logic, Negotiation, Simulation Terminal, Messages, Contracts, Draft mechanics — no changes beyond the BCO field where required.
