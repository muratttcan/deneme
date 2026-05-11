// Perfect-Information Monte Carlo (PIMC) solver.
//
// Idea: the real objective is P(final score >= 550), not E[points per flip].
// Those two are different — e.g. when we're well below 550, a gamble with
// higher variance is correct because it's the only way to reach gold.
//
// Algorithm:
//   1. Sample N full-board assignments consistent with everything observed
//      (revealed values + flash constraints).
//   2. For each candidate first move (any legal flip or catch), simulate the
//      rest of the game in every sampled world under a simple full-info
//      policy; record the final score.
//   3. Pick the move that maximises P(>=550), tiebreak on P(>=400), then on
//      E[score].
//
// Rolling out needs a policy — but with perfect info the "optimal chain"
// rule is simple and close enough: take chain-extending moves first, prefer
// cells hand=5 can't reach on lower hands, reveal K for free on the K-turn,
// cap the turn with same-value only when nothing else is available.

import {
  NEIGHBORS,
  BINGO_LINES,
  CELL_COUNT,
  HAND_SEQUENCE,
  currentCard,
  isGameOver,
  recordReveal,
  catchCell,
  compareHandVsRevealed,
  pointsFor,
  enumerate5Placements,
  isSafeFor5Turn,
} from "./game.js";
import { suggestMove as heuristicSuggest } from "./solver.js";

// Chest breakpoints. Gold and silver are game-canonical (README line 18).
// Bronze is not spelled out in the rules — 100 is a reasonable "this isn't
// a total disaster" threshold; tweak if the real value differs.
export const CHEST_THRESHOLDS = { bronze: 100, silver: 400, gold: 550 };

const NON_FIVE_VALUES = ["1", "2", "3", "4", "K"];

function cloneState(state) {
  const cells = new Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    cells[i] = {
      state: c.state,
      value: c.value,
      flashed: c.flashed,
      scored: c.scored,
    };
  }
  return {
    cells,
    remaining: { ...state.remaining },
    handIndex: state.handIndex,
    score: state.score,
    completedBingos: new Set(state.completedBingos),
    history: [], // rollout never undoes
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

// Build one complete value assignment for the 5x5 board. Revealed cells keep
// their known values; a random constraint-satisfying 5-placement is drawn
// from `placements`; non-5 values are uniformly permuted over what's left.
function sampleWorld(state, placements) {
  const world = new Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    if (c.state === "revealed") world[i] = c.value;
  }

  const placement = placements[Math.floor(Math.random() * placements.length)];
  for (const idx of placement) world[idx] = "5";

  const pool = [];
  for (const v of NON_FIVE_VALUES) {
    for (let j = 0; j < state.remaining[v]; j++) pool.push(v);
  }
  shuffle(pool);

  const placementSet = new Set(placement);
  let k = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    if (state.cells[i].state === "revealed") continue;
    if (placementSet.has(i)) continue;
    world[i] = pool[k++];
  }
  return world;
}

function sampleWorlds(state, n) {
  const placements = enumerate5Placements(state);
  if (placements.length === 0) return [];
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = sampleWorld(state, placements);
  return out;
}

// A same-value catch is "dominated" when some later hand h > cellValue will
// chain-catch the same cell. Chain-catching scores the same points AND keeps
// the turn alive, so catching now is strictly worse. PIMC's full-info rollout
// can't see this (it makes up for it downstream in each world), so we prune
// these moves before evaluating to stop strategy-fusion noise from surfacing
// them as suggestions.
//
// Special cases:
//  - hand=5 catching 5, hand=K catching K: no higher future hand exists, keep.
//  - hand=4 catching 4: only dominated if the cell is safe-for-5 (hand=5 can
//    actually reach it to chain-catch). Unsafe-for-5 cells can't be claimed
//    on hand=5, so catching now is correct.
function isDominatedSameValueCatch(state, hand, cellIdx) {
  const cellVal = state.cells[cellIdx].value;
  if (cellVal === "5" || cellVal === "K") return false;
  const vn = Number(cellVal);
  const futureHands = HAND_SEQUENCE.slice(state.handIndex + 1);
  for (const h of futureHands) {
    if (h === "K") continue;
    if (Number(h) <= vn) continue;
    if (h === "5") {
      if (isSafeFor5Turn(state, cellIdx)) return true;
      continue;
    }
    return true;
  }
  return false;
}

// Every legal first move: any hidden cell can be flipped, and any revealed-
// unscored cell with a catchable value can be caught. We intentionally do NOT
// filter out hand=5 catches/flips that look unsafe from the state alone —
// in some sampled worlds they ARE safe, and PIMC should weigh that.
function candidateMoves(state) {
  const hand = currentCard(state);
  if (!hand) return [];

  const moves = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    if (c.state !== "revealed" || c.scored) continue;
    const cmp = compareHandVsRevealed(hand, c.value);
    if (cmp === "lose") continue;
    if (cmp === "score" && isDominatedSameValueCatch(state, hand, i)) continue;
    moves.push({ type: "catch", idx: i });
  }
  for (let i = 0; i < CELL_COUNT; i++) {
    if (state.cells[i].state === "hidden") {
      moves.push({ type: "flip", idx: i });
    }
  }
  return moves;
}

// Apply a catch inside a rollout. Safety on hand=5 is decided from the world's
// ground truth (any adjacent 5 — revealed or face-down — catches the 5-card),
// not from state-level probabilities as catchCell() does. Bingos for scored
// catches fire here too.
function applyCatchInRollout(state, idx, world) {
  const cell = state.cells[idx];
  if (cell.state !== "revealed" || cell.scored) return;
  const hand = currentCard(state);
  if (!hand) return;
  const cmp = compareHandVsRevealed(hand, cell.value);
  if (cmp === "lose") return;

  if (hand === "5") {
    let caught = false;
    for (const n of NEIGHBORS[idx]) {
      const nc = state.cells[n];
      if (nc.state === "revealed" && nc.value === "5") { caught = true; break; }
      if (nc.state === "hidden" && world[n] === "5") { caught = true; break; }
    }
    if (caught) {
      state.handIndex += 1;
      return;
    }
  }

  cell.scored = true;
  let gained = pointsFor(cell.value);
  for (let lineIdx = 0; lineIdx < BINGO_LINES.length; lineIdx++) {
    if (state.completedBingos.has(lineIdx)) continue;
    const line = BINGO_LINES[lineIdx];
    if (!line.includes(idx)) continue;
    let complete = true;
    for (const i of line) {
      const c = state.cells[i];
      if (c.state !== "revealed" || !c.scored) { complete = false; break; }
    }
    if (complete) {
      state.completedBingos.add(lineIdx);
      gained += 10;
    }
  }
  state.score += gained;
  if (cmp === "score") state.handIndex += 1;
}

function applyMove(state, move, world) {
  if (move.type === "flip") {
    const v = world[move.idx];
    let flashed = false;
    for (const n of NEIGHBORS[move.idx]) {
      if (world[n] === "5") { flashed = true; break; }
    }
    recordReveal(state, move.idx, v, flashed);
  } else {
    applyCatchInRollout(state, move.idx, world);
  }
}

// Full-info rollout policy. Each call returns the single move the rollout
// "player" will make next, given the known world.
//
// Philosophy across all hands:
//   1) extend the chain (catch < hand, then flip < hand with a bias toward
//      cells only low hands can safely reach),
//   2) if chains are exhausted and K is still face-down, flip K — trades 0
//      pts now for a guaranteed +100 on the K-turn,
//   3) cap the turn with a same-value catch/flip for +hand,
//   4) burn the turn only as a last resort.
function rolloutMove(state, world) {
  const hand = currentCard(state);
  if (!hand) return null;

  const adjTo5 = (idx) => {
    for (const n of NEIGHBORS[idx]) {
      if (world[n] === "5") return true;
    }
    return false;
  };

  if (hand === "K") {
    let kIdx = -1;
    for (let i = 0; i < CELL_COUNT; i++) {
      if (world[i] === "K") { kIdx = i; break; }
    }
    if (kIdx === -1) return null;
    const c = state.cells[kIdx];
    if (c.state === "revealed") {
      return c.scored ? null : { type: "catch", idx: kIdx };
    }
    return { type: "flip", idx: kIdx };
  }

  if (hand === "5") {
    // 1) Safe chain catches (rev-unscored, 1..4).
    let best = -1, bestV = -1;
    for (let i = 0; i < CELL_COUNT; i++) {
      const c = state.cells[i];
      if (c.state !== "revealed" || c.scored) continue;
      if (c.value === "K" || c.value === "5") continue;
      if (adjTo5(i)) continue;
      const vn = Number(c.value);
      if (vn > bestV) { bestV = vn; best = i; }
    }
    if (best !== -1) return { type: "catch", idx: best };

    // 2) Safe hidden flips with value 1..4.
    best = -1; bestV = -1;
    for (let i = 0; i < CELL_COUNT; i++) {
      const c = state.cells[i];
      if (c.state !== "hidden") continue;
      if (adjTo5(i)) continue;
      const v = world[i];
      if (v === "K" || v === "5") continue;
      const vn = Number(v);
      if (vn > bestV) { bestV = vn; best = i; }
    }
    if (best !== -1) return { type: "flip", idx: best };

    // 3) K still hidden? Flip it regardless of adjacency — the turn ends 0 pts
    // either way (lose to K, or caught by a 5-neighbor), but K is revealed, so
    // the K-turn becomes a guaranteed +100. Beats a +50 5-cap on average.
    for (let i = 0; i < CELL_COUNT; i++) {
      const c = state.cells[i];
      if (c.state === "hidden" && world[i] === "K") {
        return { type: "flip", idx: i };
      }
    }

    // 4) Cap with a safe 5 (catch first, else flip).
    for (let i = 0; i < CELL_COUNT; i++) {
      const c = state.cells[i];
      if (c.state === "revealed" && !c.scored && c.value === "5" && !adjTo5(i)) {
        return { type: "catch", idx: i };
      }
    }
    for (let i = 0; i < CELL_COUNT; i++) {
      const c = state.cells[i];
      if (c.state !== "hidden") continue;
      if (world[i] !== "5") continue;
      if (adjTo5(i)) continue;
      return { type: "flip", idx: i };
    }

    // 5) No safe move. Burn the turn on something unsafe so we advance.
    for (let i = 0; i < CELL_COUNT; i++) {
      if (state.cells[i].state === "hidden") return { type: "flip", idx: i };
    }
    return null;
  }

  // Hands 1..4.
  const h = Number(hand);

  // 1) Chain catches (rev-unscored, v < h). Take highest v.
  let best = -1, bestV = -1;
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    if (c.state !== "revealed" || c.scored) continue;
    if (c.value === "K") continue;
    const vn = Number(c.value);
    if (vn >= h) continue;
    if (vn > bestV) { bestV = vn; best = i; }
  }
  if (best !== -1) return { type: "catch", idx: best };

  // 2) Hidden flips with v < h. "Dangerous" cells (adjacent to a 5 in this
  // world) MUST be cleared by hands 1..4 since hand=5 can't safely touch
  // them — prioritise those, then fall back on value.
  best = -1;
  let bestPri = -Infinity;
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    if (c.state !== "hidden") continue;
    const v = world[i];
    if (v === "K" || v === "5") continue;
    const vn = Number(v);
    if (vn >= h) continue;
    const pri = (adjTo5(i) ? 1000 : 0) + vn;
    if (pri > bestPri) { bestPri = pri; best = i; }
  }
  if (best !== -1) return { type: "flip", idx: best };

  // 3) K still hidden? Flip it — turn ends 0 pts but the K-turn becomes a
  // guaranteed +100, which beats a +h cap.
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    if (c.state === "hidden" && world[i] === "K") {
      return { type: "flip", idx: i };
    }
  }

  // 4) Same-value cap (catch first, then flip).
  const hStr = String(h);
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    if (c.state === "revealed" && !c.scored && c.value === hStr) {
      return { type: "catch", idx: i };
    }
  }
  for (let i = 0; i < CELL_COUNT; i++) {
    const c = state.cells[i];
    if (c.state === "hidden" && world[i] === hStr) {
      return { type: "flip", idx: i };
    }
  }

  // 5) Burn the turn on any hidden cell.
  for (let i = 0; i < CELL_COUNT; i++) {
    if (state.cells[i].state === "hidden") return { type: "flip", idx: i };
  }
  return null;
}

function rolloutFromMove(originalState, firstMove, world) {
  const state = cloneState(originalState);
  applyMove(state, firstMove, world);
  // 25 cells + some catches — a full game never exceeds ~50 actions.
  let safety = 80;
  while (!isGameOver(state) && safety-- > 0) {
    const m = rolloutMove(state, world);
    if (!m) break;
    applyMove(state, m, world);
  }
  return state.score;
}

function evaluate(originalState, move, worlds) {
  let gold = 0;
  let silver = 0;
  let sum = 0;
  for (const w of worlds) {
    const s = rolloutFromMove(originalState, move, w);
    if (s >= CHEST_THRESHOLDS.gold) gold += 1;
    if (s >= CHEST_THRESHOLDS.silver) silver += 1;
    sum += s;
  }
  const n = worlds.length;
  return {
    pGold: gold / n,
    pSilver: silver / n,
    eScore: sum / n,
  };
}

// Return > 0 if `b` is strictly better than `a`, < 0 if worse, 0 if tied.
function compareStats(a, b) {
  if (Math.abs(a.pGold - b.pGold) > 0.005) return b.pGold - a.pGold;
  if (Math.abs(a.pSilver - b.pSilver) > 0.005) return b.pSilver - a.pSilver;
  if (Math.abs(a.eScore - b.eScore) > 1) return b.eScore - a.eScore;
  return 0;
}

export function suggestMovePIMC(state, options = {}) {
  const N = options.N ?? 200;
  const hand = currentCard(state);
  if (!hand) return null;

  const moves = candidateMoves(state);
  if (moves.length === 0) return null;

  // Fast-path: K in hand + K already revealed-unscored is a guaranteed +100.
  // No need to burn 200 rollouts on it.
  if (hand === "K") {
    for (const m of moves) {
      const c = state.cells[m.idx];
      if (m.type === "catch" && c.value === "K") {
        return {
          cellIdx: m.idx,
          score: 100,
          reason: "Click your K card on this King cell for +100",
        };
      }
    }
  }

  const worlds = sampleWorlds(state, N);
  if (worlds.length === 0) return null;

  let bestMove = null;
  let bestStats = null;
  const allStats = [];
  for (const m of moves) {
    const stats = evaluate(state, m, worlds);
    allStats.push({ move: m, stats });
    if (!bestStats || compareStats(bestStats, stats) > 0) {
      bestStats = stats;
      bestMove = m;
    }
  }

  const pct = (x) => Math.round(x * 100) + "%";
  const reason =
    `P(≥550)=${pct(bestStats.pGold)} · P(≥400)=${pct(bestStats.pSilver)} · ` +
    `E[score]≈${Math.round(bestStats.eScore)} (${N} rollouts)`;

  return {
    cellIdx: bestMove.idx,
    score: bestStats.pGold,
    reason,
    pimc: {
      bestStats,
      allStats,
    },
  };
}

// Policy-rollout action selection (Tesauro & Galperin 1996).
//
// PIMC's strategy-fusion bias comes from the rollout policy SEEING the sampled
// world's ground truth. Fix: keep world sampling, but use the heuristic
// solver — which only sees the information set — as the rollout policy. The
// estimate is an unbiased E[final score | first move = M, heuristic plays
// out the rest], and "policy rollout" is provably ≥ the base policy in
// expectation. We rank candidate first moves by E[score] under this estimate.
//
// Cost is high (each rollout = ~12 heuristic calls); hence the small-N option
// and a dedicated bench rather than browser-live use.
function rolloutWithHeuristicAfter(originalState, firstMove, world) {
  const state = cloneState(originalState);
  applyMove(state, firstMove, world);
  let safety = 80;
  while (!isGameOver(state) && safety-- > 0) {
    const sug = heuristicSuggest(state);
    if (!sug || sug.cellIdx == null) break;
    const idx = sug.cellIdx;
    const cell = state.cells[idx];
    if (cell.state === "hidden") {
      const v = world[idx];
      let flashed = false;
      for (const n of NEIGHBORS[idx]) {
        if (world[n] === "5") { flashed = true; break; }
      }
      recordReveal(state, idx, v, flashed);
    } else {
      if (!catchCell(state, idx)) break;
    }
  }
  return state.score;
}

export function suggestMovePolicyRollout(state, options = {}) {
  const N = options.N ?? 50;
  const hand = currentCard(state);
  if (!hand) return null;
  const moves = candidateMoves(state);
  if (moves.length === 0) return null;

  // Same K-fast-path as PIMC: don't burn rollouts on a guaranteed +100.
  if (hand === "K") {
    for (const m of moves) {
      const c = state.cells[m.idx];
      if (m.type === "catch" && c.value === "K") {
        return { cellIdx: m.idx, score: 100, reason: "K on revealed K = +100" };
      }
    }
  }

  const worlds = sampleWorlds(state, N);
  if (worlds.length === 0) return null;

  // Score each move = E[final score under heuristic rollout]. Unlike full
  // perfect-info PIMC, mean score is the right objective here — strategy
  // fusion is gone, so the bias toward "would-be-good-with-perfect-info"
  // moves is gone too.
  let bestMove = null;
  let bestMean = -Infinity;
  let bestPGold = 0;
  const allStats = [];
  for (const m of moves) {
    let sum = 0, gold = 0;
    for (const w of worlds) {
      const s = rolloutWithHeuristicAfter(state, m, w);
      sum += s;
      if (s >= CHEST_THRESHOLDS.gold) gold += 1;
    }
    const mean = sum / N;
    const pGold = gold / N;
    allStats.push({ move: m, mean, pGold });
    if (mean > bestMean) { bestMean = mean; bestMove = m; bestPGold = pGold; }
  }
  return {
    cellIdx: bestMove.idx,
    score: bestMean,
    reason: `policy-rollout E[score]≈${Math.round(bestMean)}, P(≥550)=${Math.round(bestPGold*100)}% (N=${N})`,
    rollout: { allStats, bestMean, bestPGold },
  };
}

// Play the rest of the game using the heuristic solver as the policy,
// resolving every reveal against `world`'s ground-truth values. This mirrors
// what a player following the heuristic would actually experience.
function playoutWithHeuristic(originalState, world) {
  const state = cloneState(originalState);
  let safety = 80;
  while (!isGameOver(state) && safety-- > 0) {
    const sug = heuristicSuggest(state, undefined, { skipSearch: true });
    if (!sug || sug.cellIdx == null) break;
    const idx = sug.cellIdx;
    const cell = state.cells[idx];
    if (cell.state === "hidden") {
      const v = world[idx];
      let flashed = false;
      for (const n of NEIGHBORS[idx]) {
        if (world[n] === "5") { flashed = true; break; }
      }
      recordReveal(state, idx, v, flashed);
    } else {
      if (!catchCell(state, idx)) break;
    }
  }
  return state.score;
}

// P(reach each chest) from the current state, assuming the heuristic plays
// out the rest. This isn't used to pick moves (strategy fusion would bite) —
// it only reports "how's it looking from here?" so the user can see whether
// they're still on a gold trajectory. Deterministic once the game is over.
export function computeChestProbabilities(state, options = {}) {
  // Adaptive N: late-game states have very few moves left so each rollout
  // is cheap, and they're exactly when the user wants a sharp percentage
  // (e.g. K-turn with 3 candidates ≈ exactly 1/3 if math is honest, but
  // N=40 has SE ~7.5pp and would routinely show 25% / 33% / 40%). Scale
  // up N when there's little left to simulate so the displayed number
  // is precise enough to trust.
  let hiddenCount = 0;
  for (const c of state.cells) if (c.state === "hidden") hiddenCount += 1;
  // Targeted ~40 ms per call across early-cases by extrapolating from
  // measured wall-times: per-rollout cost scales with hidden-cell count, so
  // budgets grow inversely. >12 hidden is left at N=60 because it's already
  // over the budget at that size (one full game playout per world).
  const adaptiveN = hiddenCount <= 4 ? 4000
    : hiddenCount <= 8 ? 1000
    : hiddenCount <= 12 ? 250
    : 60;
  const N = options.N ?? adaptiveN;
  const thresholds = options.thresholds ?? CHEST_THRESHOLDS;

  if (isGameOver(state)) {
    const s = state.score;
    return {
      pBronze: s >= thresholds.bronze ? 1 : 0,
      pSilver: s >= thresholds.silver ? 1 : 0,
      pGold: s >= thresholds.gold ? 1 : 0,
      eScore: s,
      samples: 0,
      gameOver: true,
      thresholds,
    };
  }

  const worlds = sampleWorlds(state, N);
  if (worlds.length === 0) {
    const s = state.score;
    return {
      pBronze: s >= thresholds.bronze ? 1 : 0,
      pSilver: s >= thresholds.silver ? 1 : 0,
      pGold: s >= thresholds.gold ? 1 : 0,
      eScore: s,
      samples: 0,
      thresholds,
    };
  }

  let bronze = 0, silver = 0, gold = 0, sum = 0;
  for (const w of worlds) {
    const score = playoutWithHeuristic(state, w);
    if (score >= thresholds.bronze) bronze += 1;
    if (score >= thresholds.silver) silver += 1;
    if (score >= thresholds.gold) gold += 1;
    sum += score;
  }
  const n = worlds.length;
  return {
    pBronze: bronze / n,
    pSilver: silver / n,
    pGold: gold / n,
    eScore: sum / n,
    samples: n,
    thresholds,
  };
}
