# Solver improvement log

## Where we started
| | Gold rate |
|---|---|
| Hand-tuned starting point | **~31.6%** |

## Wins (shipped)
| Change | Effect | Cumulative |
|---|---|---|
| `tune.mjs` random search (chainBonusMul, infoWeight) | +8.5pp | ~40.1% |
| Hardcoded `[1,3,16,18]` dominating-set opener | +1.7pp | ~41.8% |
| Shannon info gain about 5-placement (replaced hand-crafted proxy) | +0.5pp | ~42.4% |
| Joint catch penalty (placement-based instead of independence approx.) | neutral, kept for correctness | ~42.4% |
| **Bingo-progress accumulator** (`bingoProgressWeight=12`) | **+1.4pp** | **43.8%** |
| Gold-priority leaf in late-game search (P(score≥550) dominant when score < 550) | aggregate flat at n=100k, but fixes user-reported borderline scenarios | **43.8%** |
| Dead-line filter on bingo bonuses + extended search trigger (≤7 hidden when below target) | +0.2pp at n=100k, fixes user-reported phantom-bingo case (revealed-unscored 4 next to revealed 5 → line is dead) | **44.0%** ← current |

## Tried, didn't pan out (reverted or never shipped)
| Experiment | Mechanism | Result |
|---|---|---|
| Bounded mid-game expectimax | depth-3 search at hand=4 | regressed 20→37% |
| `riskWeight` / `urgencyFactor` | risk-aware EV | failed, reverted |
| Phase-split weight tuning | early/mid/late tunables | +0.1pp (noise), kept scaffolding |
| Liveness filter on bingo lines | discount lines with stuck 5s | neutral, removed |
| Plant penalty | pre-5 reveal risk to chain catches | neutral, removed |
| Free-the-prisoner bonus | hand=5 reveals that unblock 4s | +0.03pp, removed |
| Branching opener (flash, K-aborts) | adapt opener based on flip-1 outcome | neutral |
| Brute-force opener search | best of 79 dominating sets | no robust winner across seeds |
| Worker-thread parallelization | speed up bench/tune | only 2.4× (HT-limited), reverted |

## Diagnostic tools built
- **bench-decompose.mjs** — score leak attribution (K=94% captured, 5-turn ~31 of 150, bingos 3.4 of 12, revealed-unscored 4s = 66 pts/game half-luck-half-recoverable)
- **bench-regret.mjs** — per-hand swap-to-second-best regret analysis (solver right on average; hand 1 most wobbly; hand 5 solidest)

## Net journey
**31.6% → 43.8%** gold rate over the engagement, with `bingo-progress` being the largest single mechanism gain.
