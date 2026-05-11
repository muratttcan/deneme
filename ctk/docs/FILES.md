# File reference

What every file in `ctk/` is for, in plain English. Skim this when you
come back to the project after a while and forget what's where.

## Browser app (loaded by `index.html`)

| File | Purpose |
|---|---|
| `index.html` | Page shell. Markup for the board, side panels (chest rates, session, global counters, suggestion), modals (about/impressum/privacy), Twitch chat mount, money-rain container, audio. Loads `main.js` as a module. |
| `style.css` | All styles. Board grid, cell states, suggestion glow, money rain, like button, header toggles, chat sidebar, modal overlay, mobile responsive bits. |
| `main.js` | Top-level wiring. Imports state model + solver, runs the game loop, handles UI events, manages session/global counters (abacus.jasoncameron.dev), money-rain animation, sound, modals, language toggle, page-views counter, Twitch consent gate. |
| `ui.js` | DOM rendering and input handling — keeps game/solver state isolated from the page. Renders the board, possible-5 highlighting, suggestion HINT/TIPP badge, remaining counts, score panel. Reads `data-i18n*` attributes. |
| `i18n.js` | Lightweight EN/DE translation table. `t(key, params)` for dynamic strings; `applyToDOM()` swaps `data-i18n` markers. Safe to import from Node (DOM/localStorage access is guarded). |
| `ching.mp3` | Cash-register sound that plays when gold-chance hits 100%. |

## Game logic (importable from browser AND Node)

| File | Purpose |
|---|---|
| `game.js` | Pure state model. Board, hand sequence, reveal/catch transitions, bingo lines, undo. Exports constants (`NEIGHBORS`, `BINGO_LINES`, `BOARD_COUNTS`, `HAND_SEQUENCE`, `VALUES`) and helpers (`createState`, `recordReveal`, `catchCell`, `isGameOver`, `cellValueDistribution`, `fiveProbabilities`, `enumerate5Placements`, `compareHandVsRevealed`, `isSafeFor5Turn`, `deriveConstraints`). No DOM. |
| `solver.js` | Best-move suggester. Greedy one-step EV with hand-aware scoring (chain bonus, bingo bonus, partial-line credit, Shannon info gain about 5-placement, K-hunt bonus, hand=5 catch penalty). Hardcoded `[1,3,16,18]` opener. Hands off to `search.js` in the late game. Exports `suggestMove` and `DEFAULT_WEIGHTS`. |
| `search.js` | Late-game expectimax. Triggered when `handIndex ≥ 10` and ≤6 hidden cells. Two leaf evaluators: `leafScore` (max E[score], default) and `leafGoldDominant` (max P(score≥550) with score as tiebreaker, used when `state.score < 550`). Also exports `withinTurnFlipEv` for one-turn EV computation. |
| `simulate.js` | Perfect-information Monte Carlo (PIMC). Samples N full-board assignments consistent with observations, simulates each candidate first move to game end, picks the move with best outcome distribution. Used by `main.js` for the gold-chance % display; also exposed for offline experiments via `bench-policy-rollout.mjs`. |
| `solver_ev.js` | Old greedy-EV variant kept for reference. Not imported anywhere — legacy. Safe to delete. |

## Bench / tuning scripts (`ctk/bench/`)

Each one is a standalone offline experiment. They all live in `ctk/bench/`
and import from `../game.js`, `../solver.js`, etc. None of them are
imported by the browser — they exist only to be run via `node ctk/bench/<name>.mjs`.

### Diagnostic / measurement (no solver changes)

| File | Purpose |
|---|---|
| `benchmark.mjs` | Main offline benchmark. Self-plays N random games with the shipped solver, prints score distribution + tier rates + bingos + K-early stats. The yardstick for "did my change help or regress" — run before/after every solver change. Default 500 games; for chest-rate updates use 100k. |
| `bench-decompose.mjs` | Score-component decomposition: per game, tracks where points were lost (K capture %, 5s caught, bingos completed, revealed-unscored-by-value, hidden-at-end). Identifies which leak bucket to attack next. |
| `bench-regret.mjs` | Per-move regret analysis. For each face-down reveal the solver picked, replays the game from that move with the second-best candidate. Tags by hand value. Shows which hand the solver is most uncertain on. |
| `diagnose.mjs` | Cohort diagnostics. Splits self-play results by final tier (gold/silver/bronze/sub) and prints per-cohort averages — what differs between gold finishes and sub-gold finishes. |
| `ceiling.mjs` | Perfect-information ceiling. Given the full board, what's the max achievable under the hand-sequence rules? The theoretical upper bound on any deductive solver. |

### A/B and sweep tests for specific mechanisms

| File | Purpose | Status |
|---|---|---|
| `bench-bingo.mjs` | Sweep `bingoProgressWeight`. | **Won (+1.4pp)** — w=12 shipped. |
| `bench-goldobjective.mjs` | A/B: search objective E[score] vs P(gold)-dominant. | **Won (+0.45pp)** — gold-priority shipped. |
| `bench-plant.mjs` | Sweep `plantPenaltyWeight` (penalize pre-5 reveals that orphan revealed chain catches). | Reverted (neutral). |
| `bench-freed.mjs` | Sweep `freedChainWeight` (hand=5 reveals that unblock 1-4 chain catches). | Reverted (+0.03pp). |
| `bench-stranded.mjs` | Sweep `strandedWeight` (future-catch factors per revealed-unscored value). | Experimental. |
| `bench-within-turn.mjs` | A/B: within-turn expectimax vs heuristic chainBonus approximation. | Experimental. |
| `bench-policy-rollout.mjs` | A/B: PIMC policy-rollout vs heuristic baseline. | Experimental. |

### Opener experiments

| File | Purpose |
|---|---|
| `bench-opener-ab.mjs` | Hardcoded `[1,3,16,18]` opener vs heuristic-from-move-1. (Confirmed opener wins by ~2pp.) |
| `bench-opener-exit.mjs` | Tests the "stop opener early when 5s are fully informed" gate. |
| `bench-adaptive-opener.mjs` | Branching opener variants (flash/K detection, alt dominating sets). All neutral — opener structure matters more than per-game adaptation. |
| `bench-opener-brute.mjs` | Brute-force enumeration of all 79 4-cell dominating sets of the 5×5 8-grid, two-stage filter+confirm. No robust winner. |
| `bench-opener-final.mjs` | Tight n=15k 5-way comparison of top opener candidates. Confirmed shipped opener is statistically tied with alternatives. |
| `tune-opening.mjs` | Older opener tester — predefined named strategies + random openings, paired self-play. Earlier alternative to the bench- variants. |

### Weight tuners

| File | Purpose |
|---|---|
| `tune.mjs` | Random-search weight tuner. Two-stage: stage 1 evaluates N candidate configs on a small board set, stage 2 re-evaluates the top-K on a fresh larger set (avoids selection bias). The original tuner that lifted gold rate from 31.6% to 40.1% in early development. |

### Logs

| File | Purpose |
|---|---|
| `bench-bingo-100k.log` | 100k benchmark output after the bingo-progress win shipped (43.8% gold). |
| `bench-goldobj-100k.log` | 100k benchmark after the gold-priority objective shipped. |

## Documentation (`ctk/docs/`)

| File | Purpose |
|---|---|
| `FILES.md` | This file. |
| `SOLVER_LOG.md` | Engagement summary: what shipped vs what didn't, with gold-rate deltas at each step. |
| `BRAINSTORM_PROMPT.md` | Self-contained prompt to paste into another AI for a second opinion on novel solver mechanisms. |

## Project meta

| File | Purpose |
|---|---|
| `package.json` | Node project file. Mainly to mark this as an ES modules tree. |
