// Late-game expectimax. From a given state, search the full game tree to
// game-over, returning the move with highest expected final score.
//
// Decision nodes (player choice): max over candidate moves.
// Chance nodes (flip outcome): expectation over the cell's value distribution.
// Catches are deterministic (the cell's value is already known).
//
// Approximations:
//   - Use the cell's MARGINAL value distribution at each step (joint flash↔value
//     correlations are dropped). For hand=5 we explicitly marginalise flash
//     (it determines whether the cell catches the 5-card); for other hands
//     flash only affects downstream deductions, so we record the flip with
//     flashed=false to keep the branching factor down.
//   - Outcomes with P < 0.01 are pruned.
//
// Trigger lives in solver.js — this module just exports the search.

import {
  NEIGHBORS,
  CELL_COUNT,
  VALUES,
  currentCard,
  isGameOver,
  recordReveal,
  catchCell,
  compareHandVsRevealed,
  cellValueDistribution,
  fiveProbabilities,
} from "./game.js";

const PROB_EPS = 0.01;

// Leaf evaluators. Default is raw final score → maximises E[score]. The
// gold-priority leaf adds a large constant when score crosses 550, so the
// combined expectation effectively maximises P(score ≥ 550) with raw
// score as a tiebreaker. The constant has to be larger than any possible
// score swing (range is 0–870) so even a 0.001 P(gold) edge dominates a
// score gradient. Picked 100000 → P(gold) increase of 0.001 ≈ 100 score.
const GOLD_LEAF_BONUS = 100000;
const SCORE_TARGET_FOR_GOLD = 550;
const leafScore = (state) => state.score;
const leafGoldDominant = (state) => state.score + (state.score >= SCORE_TARGET_FOR_GOLD ? GOLD_LEAF_BONUS : 0);

function cloneState(state) {
  const cells = new Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    cells[i] = {
      state: c.state, value: c.value, flashed: c.flashed, scored: c.scored,
    };
  }
  return {
    cells,
    remaining: { ...state.remaining },
    handIndex: state.handIndex,
    score: state.score,
    completedBingos: new Set(state.completedBingos),
    history: [],
  };
}

// Every legal move from `state`. We don't filter dominated catches here —
// expectimax handles dominance automatically by picking the best EV.
function generateMoves(state) {
  const hand = currentCard(state);
  if (!hand) return [];
  const moves = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    if (c.state === "revealed" && !c.scored) {
      const cmp = compareHandVsRevealed(hand, c.value);
      if (cmp !== "lose") moves.push({ type: "catch", idx: i });
    } else if (c.state === "hidden") {
      moves.push({ type: "flip", idx: i });
    }
  }
  return moves;
}

// P(any neighbour of cellIdx is a 5). Revealed-5 neighbour fixes it to 1;
// otherwise we treat hidden neighbours' P(5) as independent (a known
// approximation — the joint distribution would be tighter, but this is the
// same prior the heuristic uses).
function probFlash(state, cellIdx, pFive) {
  for (const n of NEIGHBORS[cellIdx]) {
    const nc = state.cells[n];
    if (nc.state === "revealed" && nc.value === "5") return 1;
  }
  let pNo = 1;
  for (const n of NEIGHBORS[cellIdx]) {
    const nc = state.cells[n];
    if (nc.state !== "hidden") continue;
    pNo *= 1 - (pFive.get(n) ?? 0);
  }
  return 1 - pNo;
}

// Expected leaf value under optimal play from `state`. `budget` is a
// shared node counter; when it's exhausted we bail out with the leaf
// value so the search degrades gracefully on pathological inputs
// instead of hanging. `leafFn` is the terminal evaluator — defaults to
// raw score; pass `leafGoldDominant` to optimise for P(score ≥ 550).
function evalState(state, budget, leafFn) {
  if (budget.nodes++ > budget.cap) return leafFn(state);
  if (isGameOver(state)) return leafFn(state);
  const hand = currentCard(state);
  if (!hand) return leafFn(state);

  const moves = generateMoves(state);
  if (moves.length === 0) return leafFn(state);

  const dist = cellValueDistribution(state);
  const pFive = hand === "5" ? fiveProbabilities(state) : null;

  let bestEv = -Infinity;
  for (const m of moves) {
    const ev = evalMove(state, m, dist, pFive, budget, leafFn);
    if (ev > bestEv) bestEv = ev;
    if (budget.nodes > budget.cap) break;
  }
  return bestEv === -Infinity ? leafFn(state) : bestEv;
}

// Expected leaf value after committing to move `m`.
function evalMove(state, m, dist, pFive, budget, leafFn) {
  if (m.type === "catch") {
    const ns = cloneState(state);
    const r = catchCell(ns, m.idx);
    if (!r) return leafFn(state); // refused — treat as no-op
    return evalState(ns, budget, leafFn);
  }

  const cellDist = dist.get(m.idx);
  const hand = currentCard(state);
  let ev = 0;
  let totalP = 0;

  if (hand === "5") {
    const pF = probFlash(state, m.idx, pFive);
    for (const v of VALUES) {
      const p = cellDist[v] ?? 0;
      if (p < PROB_EPS) continue;
      totalP += p;
      if (pF > 0) {
        const ns = cloneState(state);
        recordReveal(ns, m.idx, v, true);
        ev += p * pF * evalState(ns, budget, leafFn);
      }
      if (pF < 1) {
        const ns = cloneState(state);
        recordReveal(ns, m.idx, v, false);
        ev += p * (1 - pF) * evalState(ns, budget, leafFn);
      }
    }
  } else {
    for (const v of VALUES) {
      const p = cellDist[v] ?? 0;
      if (p < PROB_EPS) continue;
      totalP += p;
      const ns = cloneState(state);
      recordReveal(ns, m.idx, v, false);
      ev += p * evalState(ns, budget, leafFn);
    }
  }
  if (totalP < 0.999) ev += (1 - totalP) * leafFn(state);
  return ev;
}

// ── Within-turn expectimax ─────────────────────────────────────────────────
//
// A second, scoped search variant: simulate ONLY the rest of the current turn
// (treat turn-end as terminal) and return expected POINTS GAINED in this turn.
// Used by the solver as an exact replacement for the heuristic
// chainBonus = chainP × avgRemainingPoints × mul approximation.
//
// Why this avoids the failed mid-game expectimax leaf-eval problem: every
// branch terminates at a well-defined turn boundary (handIndex advances) with
// no remaining future to estimate. The score gained is exactly the points
// awarded by recordReveal/catchCell/bingo events during this turn.

function evalRestOfTurn(state, startingHandIndex, baseScore, budget) {
  if (budget.nodes++ > budget.cap) return state.score - baseScore;
  if (state.handIndex !== startingHandIndex) return state.score - baseScore;
  if (isGameOver(state)) return state.score - baseScore;

  const moves = generateMoves(state);
  if (moves.length === 0) return state.score - baseScore;

  const dist = cellValueDistribution(state);
  const hand = currentCard(state);
  const pFive = hand === "5" ? fiveProbabilities(state) : null;

  let bestGain = 0; // option of stopping (won't normally fire — turn-end is forced)
  for (const m of moves) {
    const gain = evalMoveTurnBound(state, m, dist, pFive, startingHandIndex, baseScore, budget);
    if (gain > bestGain) bestGain = gain;
    if (budget.nodes > budget.cap) break;
  }
  return bestGain;
}

function evalMoveTurnBound(state, m, dist, pFive, startingHandIndex, baseScore, budget) {
  if (m.type === "catch") {
    const ns = cloneState(state);
    const r = catchCell(ns, m.idx);
    if (!r) return 0;
    return evalRestOfTurn(ns, startingHandIndex, baseScore, budget);
  }
  const cellDist = dist.get(m.idx);
  const hand = currentCard(state);
  let ev = 0;
  if (hand === "5") {
    const pF = probFlash(state, m.idx, pFive);
    for (const v of VALUES) {
      const p = cellDist[v] ?? 0;
      if (p < PROB_EPS) continue;
      if (pF > 0) {
        const ns = cloneState(state);
        recordReveal(ns, m.idx, v, true);
        ev += p * pF * evalRestOfTurn(ns, startingHandIndex, baseScore, budget);
      }
      if (pF < 1) {
        const ns = cloneState(state);
        recordReveal(ns, m.idx, v, false);
        ev += p * (1 - pF) * evalRestOfTurn(ns, startingHandIndex, baseScore, budget);
      }
    }
  } else {
    for (const v of VALUES) {
      const p = cellDist[v] ?? 0;
      if (p < PROB_EPS) continue;
      const ns = cloneState(state);
      recordReveal(ns, m.idx, v, false);
      ev += p * evalRestOfTurn(ns, startingHandIndex, baseScore, budget);
    }
  }
  return ev;
}

// Public entry: expected points gained THIS TURN if the player commits to
// flipping `cellIdx` next, then plays the rest of the turn optimally.
// Does not include any future-turn value.
export function withinTurnFlipEv(state, cellIdx, options = {}) {
  const budget = { nodes: 0, cap: options.maxNodes ?? 4000 };
  const dist = cellValueDistribution(state);
  const hand = currentCard(state);
  const pFive = hand === "5" ? fiveProbabilities(state) : null;
  const startingHandIndex = state.handIndex;
  const baseScore = state.score;
  return evalMoveTurnBound(
    state,
    { type: "flip", idx: cellIdx },
    dist,
    pFive,
    startingHandIndex,
    baseScore,
    budget,
  );
}

// Pick the move with highest expected leaf value. `maxNodes` bounds total
// state-evaluations; default 50k is fast enough for browser interactive use.
// `objective` selects the leaf evaluator:
//   - "score" (default): raw final score → maximises E[score].
//   - "gold":  P(score ≥ 550) is dominant, with raw score as a tiebreaker.
export function suggestMoveSearch(state, options = {}) {
  const hand = currentCard(state);
  if (!hand) return null;
  const moves = generateMoves(state);
  if (moves.length === 0) return null;

  const budget = { nodes: 0, cap: options.maxNodes ?? 50000 };
  const dist = cellValueDistribution(state);
  const pFive = hand === "5" ? fiveProbabilities(state) : null;
  const goldMode = options.objective === "gold";
  const leafFn = goldMode ? leafGoldDominant : leafScore;

  let bestMove = null;
  let bestEv = -Infinity;
  for (const m of moves) {
    const ev = evalMove(state, m, dist, pFive, budget, leafFn);
    if (ev > bestEv) {
      bestEv = ev;
      bestMove = m;
    }
    if (budget.nodes > budget.cap) break;
  }
  if (!bestMove) return null;
  // combined leaf = E[score] + GOLD_LEAF_BONUS × P(gold). With E[score] ≤
  // 870 ≪ GOLD_LEAF_BONUS the integer-quotient approximates P(gold)
  // closely; the remainder approximates E[score]. Good enough for the
  // human-readable reason string.
  let reason;
  let pGold = null;
  let eScore = null;
  if (goldMode) {
    pGold = Math.min(1, Math.max(0, Math.round(bestEv / GOLD_LEAF_BONUS * 100) / 100));
    eScore = Math.max(0, bestEv - pGold * GOLD_LEAF_BONUS);
    reason = `Gold-priority: P(gold)≈${(pGold*100).toFixed(0)}%, E[score]≈${Math.round(eScore)} (search · ${budget.nodes} nodes)`;
  } else {
    reason = `Expected final ${Math.round(bestEv)} (search · ${budget.nodes} nodes)`;
    eScore = bestEv;
  }
  return {
    cellIdx: bestMove.idx,
    score: bestEv,
    reason,
    searchExhausted: budget.nodes > budget.cap,
    pGold,
    eScore,
    searchObjective: goldMode ? "gold" : "score",
  };
}
