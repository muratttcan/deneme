# Catch the King Helper

A browser-based helper for Metin2's **Schnapp den König** minigame. You enter
what you see on the real client; it deduces where the 5s and the King are,
suggests the best next move, and shows your live probability of clearing the
**550-point gold chest**.

**Use it:** <https://dominikloefflerniteo.github.io/ctk-helper-jogoe/ctk/>

No build step — pure HTML/CSS/JS that GitHub Pages serves directly.

## The game

- **Board:** 5×5 grid, 25 face-down cards. Composition: `7×1, 4×2, 5×3, 5×4, 3×5, 1×K`.
- **Hand:** 12 cards played lowest-first: `5×1, 2×2, 2×3, 1×4, 1×5, 1×K`.
- **Each turn:** flip a face-down card and compare with the hand card.
  - Hand higher than revealed → score revealed value, **chain** (flip again).
  - Hand same as revealed → score, turn ends.
  - Hand lower than revealed → no score, turn ends. The cell stays
    revealed-but-unscored and can be **caught later** by a higher hand card.
- **Flash:** flipping a cell while any face-down 5 is an 8-neighbor "flashes"
  the card.
- **5-turn:** a flashed flip during hand=5 catches the 5-card — 0 points,
  turn ends. Chain catches during hand=5 also require the cell to be
  safe-for-5 (no adjacent 5).
- **K-turn:** clicking on the K with the K-card scores +100 and ends the game.
- **Bingo:** every row, column, and both diagonals. When every cell on a line
  has been both revealed AND **scored**, +10 bonus.
- **Target:** silver = 400, **gold = 550**. The solver is tuned for gold.

## What the helper does

### Input

Hover a cell, then key or click:

| Action | How |
|--------|-----|
| Reveal a face-down cell with no flash (no 5 adjacent) | `1–5` / `K` / `6` |
| Reveal a face-down cell with flash (a 5 is adjacent) | `Shift` + value key |
| Catch a revealed-but-unscored cell with the current hand card | **Click** the dim cell |
| Auto-fill a cell where P(value) ≥ 99.9% | **Click** (single-click on must-be-X) |
| Undo last action | `Backspace` or Undo button |
| Reset | `Esc` or Reset button |

### State tracking (`game.js`)

- Each cell has `{state, value, flashed, scored}`.
- Hand progression auto-advances based on hand vs. revealed value.
- Score tallies card values and bingo bonuses.
- `completedBingos` set prevents double-counting; undo rolls bingo events back.

### Deduction (`game.js`)

- **`mustNotBe5`** — from no-flash reveals, none of the flipped cell's
  neighbours can be a 5.
- **Flash constraints** — a flashed reveal means "≥1 of these face-down
  neighbours IS a 5"; a revealed-5 neighbour already explains the flash and
  the constraint adds no info beyond that.
- **Exact `enumerate5Placements` / `fiveProbabilities`** — enumerates every
  subset of candidate cells of size `remaining[5]` that satisfies all active
  flash constraints, then `P(5|c)` is the fraction containing `c`. Tractable
  because `remaining[5] ≤ 3`.
- **`cellValueDistribution`** — exact `P(5|c)` plus a uniform distribution of
  the non-5 remaining values over non-5 slots.
- **`isSafeFor5Turn(cell)`** — true iff every neighbour is revealed-non-5 or
  hidden with `P(5)≈0`. Used by the solver and by the green "safe-flip" tint.
- **`isTrivialSweep(state)`** — every hidden cell has fully-determined 5-status
  and the King's location is known: triggers the money-face easter egg.
- **`maxPossibleRemaining(state)`** — optimistic ceiling on remaining score
  (every still-catchable value plus unclaimed bingo lines).

### Visual state (`ui.js`, `style.css`)

| State | Visual |
|-------|--------|
| Revealed + scored | Color-coded by value |
| Revealed + unscored | Dimmed (50% opacity), pointer cursor |
| Revealed + unscored + unclaimable on 5-turn | Heavier dim, `not-allowed` cursor |
| Must-be-5 (deduced P(5)=1) | Big red 5 with dashed border |
| Possible-5 (P(5)>0) | Red tint, percentage label |
| Confirmed not-5 (P(5)=0) | Green border |
| Safe to flip with hand=5 | Thick green outline + green tint |
| Solver suggestion | Pulsing gold outline + HINT/TIPP badge |
| Trivial sweep + safe green | Wobbling money-eyes face overlay |

The right sidebar shows: current card, score with a **ceiling** (red when 550
is mathematically out of reach, green when gold is locked), live **gold-chance
%** (PIMC rollout, see below), remaining-on-board counts, and the solver's
reasoning string.

### Solver (`solver.js`)

Priority order each turn:

1. **Hardcoded opener.** The first 4 hand=1 reveals are forced to the
   dominating set `[1, 3, 16, 18]`. This covers all 25 cells with 4 reveals,
   making every face-down 5 flash-visible. Worth ~+1.7pp gold over greedy.
   Drops if the user reveals any cell outside the pattern, or if the existing
   reveals already inform every possible 5.
2. **K-turn special.** If hand=K and the K is already revealed, point at that
   cell for the +100 click.
3. **Late-game expectimax (`search.js`).** When `handIndex ≥ 10` and ≤ 6
   hidden cells (≤ 7 when score is below 550), search the full game tree.
   Two leaf evaluators:
   - `leafScore` — raw final score → maximises **E[score]**. Used when
     `state.score ≥ 550`.
   - `leafGoldDominant` — `score + 100000 × 1[score ≥ 550]` → maximises
     **P(score ≥ 550)** with raw score as a tiebreaker. Used below target so
     the search prefers lower-mean / higher-variance moves that actually clear
     the gold threshold.
4. **Chain catches.** Any revealed-unscored cell with value `<` hand. Pick
   highest-value. For hand=5, filter to safe-for-5 cells only.
5. **Face-down flips** scored per cell via `scoreCell`:
   - `ev` — expected immediate points from hand vs. value.
   - `chainBonus` — `chainP × avgRemainingPoints × chainBonusMul` (continuation
     value if this flip chains).
   - `bingoBonus` — `+10` per line this flip would complete *and* whose other
     cells are all revealed-scored *and* none of which is permanently dead
     (see dead-line filter below).
   - `bingoProgressBonus` — `Σ over incomplete lines containing the cell of
     (othersDone/4)²` × weight. Squared so 3/4-done lines dominate fresh ones.
     Excludes lines this flip would complete on its own and lines containing
     a permanently-dead cell.
   - `infoBonus` — Shannon information gain (in bits) about the 5-placement,
     computed exactly from the placement enumeration.
   - `kHuntBonus` — `P(K|cell) × kHuntWeight(state)`. Weight scales with
     score gap so K-hunt intensifies the further below 550 we are.
   - `catchPenalty` (hand=5 only) — `P(adjacent face-down is 5) × penalty`,
     using the joint distribution from the placement enumeration.
   - `reservedFor5Turn` — for hand ≤ 4 cells that are must-be-5 or safe-for-5,
     subtract `evLater` (the 5-turn would have handled them) so we don't
     double-credit.
6. **Same-value catches.** Score `pointsFor(value)` only when no higher hand
   can chain-catch the cell later:
   - hand=2 / 3 catching same-value → skip (a higher hand will chain).
   - hand=4 catching 4 → only if unsafe-for-5 (hand=5 can't chain-catch).
   - hand=5 catching 5 → only if safe-for-5.
   - hand=K catching K → always.

#### Dead-line filter

A revealed-unscored cell can become **permanently unscoreable** when no
remaining hand card can claim it: e.g., a revealed-unscored 4 next to a
revealed 5 past hand=4 can never be caught by hand=5 (chain requires
safety) and there's no hand=4 turn left. Lines containing such a cell can
never bingo, so both `bingoBonus` and `bingoProgressBonus` skip them.

### Live gold-chance (`simulate.js`, `gold-worker.js`)

The "Gold-chance (this game)" % is a **Perfect-Information Monte Carlo**
estimate, not the solver's heuristic. For each candidate first move:

1. Sample `N=40` full-board assignments consistent with current observations
   (revealed values + flash constraints).
2. Roll out each sampled world to game-end with a simple full-info policy.
3. Aggregate `P(final ≥ 550)` across worlds.

The rollout takes 1–2 s in late-game states, so it runs in a **Web Worker**
(`gold-worker.js`) — the main thread stays responsive while the number is
being computed. Stale jobs are cancelled when the user keeps acting.

### Counters and global state (`main.js`)

- **Session** — gold/silver/bronze counts for the current tab. Persisted to
  localStorage so a refresh doesn't reset.
- **Everyone (all time)** — global counters via the free abacus.jasoncameron.dev
  counter API. Smooth lottery-style climbs between polls; rate-limit aware.
  A `?` badge explains why this rate is lower than the solver's self-play
  rate (input typos, players ignoring suggestions, older versions, page-open
  vs. completed-game counts).
- **Like button** — same counter API, single click per browser.
- **Page-views counter** — bumped once on first load per tab.
- **Twitch chat embed** — consent-gated (clicking the placeholder loads the
  iframe; revoke from the privacy modal). No third-party data leaves the page
  until consent is given.

## File layout

```
ctk/
├── index.html, style.css, ching.mp3        Browser app shell
├── main.js, ui.js, i18n.js                 Page wiring, rendering, EN/DE strings
├── game.js                                 Pure state model + deduction
├── solver.js                               Heuristic move suggester
├── search.js                               Late-game expectimax
├── simulate.js                             PIMC rollout for gold-chance
├── gold-worker.js                          Web Worker entry for the rollout
├── bench/                                  Offline benchmark + tuning scripts
│   ├── benchmark.mjs                       Yardstick: 100k self-play, score distribution
│   ├── tune.mjs                            Random-search weight tuner
│   ├── bench-*.mjs                         Mechanism-specific A/B tests
│   ├── ceiling.mjs                         Perfect-info upper bound
│   └── diagnose.mjs                        Per-cohort outcome analysis
└── docs/
    ├── FILES.md                            Per-file purpose reference
    ├── SOLVER_LOG.md                       Engagement summary (what shipped, what didn't)
    └── BRAINSTORM_PROMPT.md                Self-contained prompt for outside AI review
```

## Deployment

1. Push all files to a public GitHub repo.
2. Repo → Settings → Pages → "Deploy from a branch" → `main` / `root`.
3. Site goes live at `https://<user>.github.io/<repo>/` within ~1 minute.
4. Each push to `main` rebuilds. Browsers cache ES modules aggressively;
   hard-refresh with `Ctrl+Shift+R` after pushing.

## Strategy baked into the helper

1. **Cover every cell with the opener.** The dominating-set `[1,3,16,18]`
   pattern in the first 4 reveals lights up every face-down 5 via flash.
2. **Spend pre-5 hands on cells the 5-turn can't reach.** Safe-for-5 cells
   are partially reserved during hand=1–4 because hand=5 will handle them.
3. **Don't same-value catch at hand=2 or 3.** A higher hand chains the catch
   without ending a turn.
4. **Chain over catch at hand=4** when safe-for-5 cells still exist —
   `reservedFor5Turn` keeps hand=4 from prematurely closing its turn.
5. **Reveal the K whenever possible.** The K-hunt weight scales with the
   gap to 550 so low-score boards lean hard into K-hunting.
6. **Bingo is a *scoring* event, not a reveal event.** Only counts when all
   five line cells are actually caught and scored. The dead-line filter
   skips lines containing a permanently unscoreable cell.
7. **Gold-priority below target.** The late-game search optimises
   `P(score ≥ 550)`, not `E[score]`. A play with lower mean but higher
   probability of clearing 550 wins the comparison.

## Solver progress / changelog

The solver shipped with a hand-tuned heuristic at ~31.6% gold rate on 100k
self-play games. Each line below records a milestone change and the gold rate
after it landed.

| Version | Gold | Change |
|---:|---:|---|
| **v0.12.10** | **44.8%** | New opener pattern `[6,8,16,18]` (community-suggested by Hanfred — symmetric "inner corners" diagonal-in from each true corner) + custom-sound picker. Opener change measured at +0.8pp / ~5σ on 100k. |
| v0.12 | 44.0% | Dead-line filter on bingos + extended late-game search to 7 hidden cells when below target. |
| v0.11 | 43.8% | Late-game search now optimises `P(score ≥ 550)` instead of `E[score]`. |
| v0.10 | 43.8% | Bingo-progress accumulator: rewards reveals that advance partial lines (squared progress ratio). |
| v0.9 | 42.4% | Exact Shannon information gain about 5-placement replaces the hand-crafted info proxy. |
| v0.8 | 41.9% | Legal pages (Impressum, privacy) + Twitch chat consent gate. |
| v0.7 | 41.9% | Chat sidebar, edge-tab collapse button, like button, page-views counter. |
| v0.6 | 41.9% | First published chest-rate display, money-rain animation on 100% gold-chance. |
| v0.5 | ~40% | `spreadWeight` board-coverage prior; offline tooling: `ceiling.mjs`, `diagnose.mjs`. |
| v0.4 | ~38% | Random-search weight tuning lifted gold rate ~+8pp. |
| v0.3 | — | `benchmark.mjs` self-play harness for offline measurement. |
| v0.2 | — | Chain bonus, K-hunt weighting, catch penalty during 5-turn. |
| v0.1 | ~31.6% | Hand-tuned baseline heuristic. |

UX-only patches (v0.12.1 – v0.12.x): Web Worker for the gold-chance compute
so the UI stays responsive, hover tooltips with version history and "why is
the all-time rate lower than the solver" explainer, panel polish.

### Things tried and reverted (negative results worth keeping)

- **Bounded mid-game expectimax** — depth-3 search at hand=4 regressed
  20→37% because budget-exhausted leaves returned `state.score` with no
  future estimate.
- **Risk-aware EV (`riskWeight`, `urgencyFactor`)** — biasing all moves
  toward variance dropped both gold and silver. The targeted gold-priority
  leaf in v0.11 is the working version of this idea.
- **Phase-split weight tuning (early/mid/late)** — random-search winner was
  +0.1pp at n=6k, regressed to noise at confirmation. Scaffolding kept.
- **Liveness filter on bingo lines (v1)** — discount lines containing stuck
  hidden 5s. Neutral. The follow-up dead-line filter in v0.12 covers the
  related but stronger case (revealed-unscored cells past their last catch
  hand) and did pay off.
- **Plant penalty** — penalize pre-5 reveals that would orphan revealed
  chain catches if the cell turned out to be a 5. Neutral; existing chain
  bonus + EV already steer away from worst cases.
- **Free-the-prisoner bonus** — hand=5 face-down reveals that could unblock
  tentatively-unsafe 1-4 chain catches. +0.03pp. Existing `infoBonus`
  already rewards reveals that disambiguate 5-positions.
- **Adaptive opener (branch on flash / K)** — neutral. Structural property
  of the dominating set matters more than per-game adaptation.
- **Brute-force opener search** over all 79 4-cell dominating sets — no
  robust winner across seeds; top candidates cluster within ±1 SE.
- **Worker-thread parallelisation** of bench/tune — only ~2.4× speedup
  on the test machine (HT-limited) and slowed the foreground UI; reverted.
- **5-resolution bonus (`fiveResolutionWeight`)** — extra binary-entropy
  reward for flips adjacent to uncertain 5-candidates, motivated by a
  user-spotted scenario where the helper picked an info-poor cell over an
  obvious 5-resolving flip. Sweep at n=5000 across w∈{10..100} all lost
  −0.7 to −1.8pp gold (z up to −1.8), with a clean monotonic decay on
  silver-band — the global Shannon term already prices the same signal,
  so adding a parallel one double-counts and disrupts the score balance.
- **Gamble aversion (`gambleAversionWeight`)** — penalty on hand 2-4 flips
  proportional to P(5), motivated by user-spotted states where the helper
  flipped a 50%-5 cell instead of catching a guaranteed same-value 4.
  Sweep at n=5000 across w∈{20..400} lost monotonically (−0.6 to −4.3pp
  gold, z up to −4.3), with silver-band staying flat or slightly higher.
  Diagnostic: the heuristic's gambling converts borderline-silver games
  into golds; removing it keeps you at silver more reliably but bleeds
  gold rate. The "wrong-feeling" suggestion is correct on average.

## Known limits

- The heuristic is greedy one-step. Late-game expectimax handles only the
  last 1–2 turns when the branching factor is small enough.
- The flash↔value joint distribution is approximated as the cell's marginal
  value distribution × marginal flash probability. For tighter inference the
  exact joint would matter, but this is the same prior the heuristic uses.
- The helper trusts player input. A typo in a reveal value or flash flag
  poisons the deduction; undo fixes it. The "Everyone (all time)" rate sits
  noticeably below the solver's self-play rate largely because of this.
- `maxPossibleRemaining` is an optimistic upper bound; realistic achievable
  is usually lower because the hand sequence constrains the catch order.
