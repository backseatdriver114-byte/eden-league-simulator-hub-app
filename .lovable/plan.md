# Plan — Relations, Press Conferences & DMs

## 1. Lock the negotiation window after the AI cancels

In `AgentNegotiationDialog.tsx` (and the AI-manager trade negotiation dialog), when the AI's final reply has `status: "cancelled"` (or equivalent):

- Render the cancellation message normally so the user can read it.
- Disable the textarea, the SEND button, and any "Counter / Accept" buttons.
- Replace the dialog footer with a single **CLOSE** button (no Cancel/Send).
- Block backdrop-click / ESC dismissal so the user must explicitly click CLOSE.

No state-engine change — purely a UI state on the dialog.

## 2. Manager Relations (user ↔ AI only)

### Data

- New `LeagueState.relations: Record<string /* aiManagerKey */, number>` where the key is the AI manager's team (since user-controlled teams are well-defined). Range 0–100, default = `settings.relationsBaseline` (50).
- New engine settings (editable in Settings suite, persisted with the rest):
  - `relationsBaseline` (default 50)
  - `relationsVolatility` (default 1.0; multiplier on every swing)
- Per-AI-manager `volatilityModifier` derived from personality (e.g. "Hot-headed" 1.5×, "Stoic" 0.6×) — stored on the manager record on generation.

### Hooks into existing flows

- After every negotiation closure (accept / counter / reject / cancel) in both the agent-negotiation and AI-manager-trade dialogs, call `applyRelationEvent(team, delta)` where `delta` is computed from outcome × tone (e.g. accept +5, polite reject −1, AI cancel after lowball −6, insult in chat −10).
- Tone scoring of user messages: an extra short Lovable AI call (cheap Gemini Flash) returns `{ tone: -3..+3 }` for each user message; multiplied by volatility into the delta.

### Effect on gameplay (intentionally minor)

- In `trade-ai.functions.ts` brief and `negotiation-brief.ts`, include `"Relationship with you: <warm/neutral/cold>"` for each user club so the AI narrates accordingly.
- In trade utility math (`src/lib/trades.ts`), add ±2 utility nudge based on relations bucket — never enough to block a clearly +EV deal (matches your "set aside differences" rule).

## 3. Press Conference feature (Newsroom suite)

### Entry points

- A "PRESS CONFERENCE" button always visible in `NewsSuite.tsx` per user-controlled team.
- When a user-club fixture exists in the active week and is unplayed → a **PRE-MATCH** prompt appears in the Newsroom feed. After the match plays → a **POST-MATCH** prompt appears (one-shot, dismissible).

### Flow

1. User clicks → server fn `startPressConference({ team, context: "general" | "pre" | "post", fixtureId? })`.
2. Lovable AI generates 3–5 questions tailored to: standings, recent results, injuries, rivals, hot players, contract drama (pulled from a fresh `buildPressBrief()` digest, same pattern as `negotiation-brief.ts`).
3. Dialog steps through each question; user types a free-form answer.
4. On submit per answer, server fn `scorePressAnswer` returns:
  ```json
   {
     "targets": [
       {"kind":"team","name":"Socks","moraleDelta":-4},
       {"kind":"player","team":"Socks","name":"...","moraleDelta":-8},
       {"kind":"manager","team":"Socks","relationDelta":-6}
     ],
     "respectDelta": -1,
     "harshness": 0.7,
     "summary": "Took a swipe at..."
   }
  ```
5. Effects applied immediately; a chyron-style toast summarizes.
6. After the last question, AI writes a short press recap that gets posted to the Newsroom feed.

### Influence math (all multiplied together, then clamped)

```
finalDelta = rawDelta
           * settings.pressInfluenceBaseline           (new slider, default 1.0)
           * managerRespect / 50                       (0.4 .. 1.6)
           * (target.team === speaker.team ? 1.5 : 1.0)
           * volatilitySlider                          (existing morale + new manager-rating volatility)
```

### New Settings sliders (live-editable, persisted)

- `pressInfluenceBaseline` (default 1.0)
- `managerRatingVolatility` (default 1.0) — scales respect drift
- `relationsBaseline`, `relationsVolatility` (from §2)

## 4. Manager Respect rating

- New `manager.respect: number` (0–100), starts at 50 for everyone (per your answer).
- New `manager.harshness: number` (0–1), updated as a running average of press-conference harshness scores.
- Weekly tick (runs as part of week advance):
  - Drift respect toward `50 + standingsTilt` where `standingsTilt = (12 - leagueRank) * 2` so first-place ≈ +22, last-place ≈ −22.
  - Harshness penalty: `penalty = -|harshness - 0.5| * 8` when |dev| > 0.25 → far extremes hurt.
  - All deltas × `managerRatingVolatility`.
- Surfaced in Newsroom + Negotiation suites (small "RESPECT 67" badge).

## 5. New "Messages" suite (private DMs)

### Targets

- All 24 managers (other than the user's own).
- Players on **user-controlled** clubs only.

### Persistence (Cloud)

- New table `public.manager_messages` storing `{ id, user_team, counterpart_kind ('manager'|'player'), counterpart_team, counterpart_name, role ('user'|'ai'), content, created_at }`. Public RLS like the rest of the project; service_role + anon SELECT.
- Loaded into a `useDmThreads(userTeam, counterpart)` hook; rendered as a chat UI per contact.

### Per-message effect (applied after every message, per your answer)

- Server fn `sendDm` posts the user message, calls Lovable AI with full thread + brief context, gets the AI reply, scores tone (`-3..+3`), then:
  - Player DM → adjust that player's `morale` by `tone * pressInfluenceBaseline * volatility * 0.5`.
  - Manager DM → adjust `relations[team]` by `tone * relationsVolatility * 1.0`.
- The thread is private; effects never leak to other managers/players.

### UI

- New `MessagesSuite.tsx` added to the 9-suite ring (becomes the 10th). Left pane: contact list grouped by "Managers" / "Your Players". Right pane: chat with the locked-input/streaming pattern from `AgentNegotiationDialog`.

## 6. Settings suite additions

Add a "Manager & Influence" group with sliders bound to `engine-settings`:

- Press influence baseline
- Manager rating volatility
- Relations baseline
- Relations volatility

Same persistence path as existing settings.

## 7. Files touched / created

**Created**

- `src/components/PressConferenceDialog.tsx`
- `src/components/MessagesSuite.tsx`
- `src/lib/press-conference.functions.ts` (start + scoreAnswer + recap)
- `src/lib/messages.functions.ts` (sendDm + scoreTone)
- `src/lib/relations.ts` (pure helpers: applyRelationEvent, bucket)
- `src/lib/respect.ts` (weekly tick math)
- `src/lib/press-brief.ts`
- `supabase/migrations/<ts>_manager_messages.sql`

**Edited**

- `src/state/league.tsx` — new fields, week-tick hook into respect, relations bootstrap on load.
- `src/lib/engine-settings.ts` — 4 new knobs + defaults.
- `src/components/SettingsSuite.tsx` — sliders + persistence.
- `src/components/AgentNegotiationDialog.tsx` + AI trade dialog — cancel-lock UI, post-close relation delta.
- `src/components/NewsSuite.tsx` — press conf entry buttons + auto-prompts.
- `src/components/NegotiationSuite.tsx` — show relation/respect badges.
- `src/lib/trades.ts` + `src/lib/negotiation-brief.ts` — surface relation tone in AI briefs and tiny utility nudge.
- `src/state/navigation.tsx` + ring carousel — add 10th suite.
- `src/integrations/supabase/types.ts` — regenerated post-migration.

## Open questions / flags before building

None that block. Two notes you should know:

1. **AI cost**: Press conferences make 2 AI calls per answer (score + recap on the last one), and DMs make 2 per user message (reply + tone). With Gemini Flash this is cheap but not free — let me know if you want me to batch tone-scoring into the reply call to halve it.
2. **AI-manager trade dialog**: you only mentioned "manager cancels a deal" — I'm assuming this also covers the player-agent dialog (same lock-on-cancel behavior). Tell me if agents should still let you keep typing. Yes, you should.

If both notes are acceptable, approve and I'll build.