// Perfect-information ceiling: given the full board, what's the maximum
// achievable score under optimal play (still obeying the hand sequence)?
// Run on N random boards and report tier distribution — this is the
// theoretical upper bound on a heuristic/probabilistic solver. The gap
// between this and our 41.9% gold rate is the real room for improvement.
//
// Search: branch-and-bound DFS over (flip | catch) actions. Reveals are
// deterministic (we know the board). Bound is `score + optimisticRemaining`.
// Per-board node cap prevents pathological boards from hanging the run.
//
// Usage: node ceiling.mjs [boards] [nodeCap]
// Default: 1000 boards · 2,000,000 nodes/board cap.

import {
  CELL_COUNT,
  NEIGHBORS,
  BINGO_LINES,
  BOARD_COUNTS,
  HAND_SEQUENCE,
  pointsFor,
  compareHandVsRevealed,
} from "../game.js";

const GOAL_GOLD = 550;

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
}
function randomBoard() {
  const v = [];
  for (const k of Object.keys(BOARD_COUNTS)) for (let i = 0; i < BOARD_COUNTS[k]; i++) v.push(k);
  shuffleInPlace(v);
  return v;
}

// Cell state codes: 0 hidden, 1 revealed-unscored, 2 scored.
function makeState() {
  return {
    cellState: new Uint8Array(CELL_COUNT),
    handIdx: 0,
    score: 0,
    bingosDone: 0, // bitmask over BINGO_LINES
  };
}

function applyBingos(s, idx) {
  let gained = 0;
  for (let li = 0; li < BINGO_LINES.length; li++) {
    const bit = 1 << li;
    if (s.bingosDone & bit) continue;
    const line = BINGO_LINES[li];
    if (line.indexOf(idx) < 0) continue;
    let all = true;
    for (let k = 0; k < line.length; k++) if (s.cellState[line[k]] !== 2) { all = false; break; }
    if (all) { s.bingosDone |= bit; gained += 10; }
  }
  return gained;
}

function applyFlip(s, idx, world) {
  const value = world[idx];
  const hand = HAND_SEQUENCE[s.handIdx];
  let flashed = false;
  for (const n of NEIGHBORS[idx]) {
    if (s.cellState[n] === 0 && world[n] === "5") { flashed = true; break; }
  }
  const u = {
    idx, prevHand: s.handIdx, prevScore: s.score, prevBingos: s.bingosDone,
  };
  s.cellState[idx] = 1;
  let gained = 0;
  let scored = false;
  let turnEnds = false;
  if (hand === "5" && flashed) {
    turnEnds = true;
  } else {
    const cmp = compareHandVsRevealed(hand, value);
    if (cmp === "score") { gained += pointsFor(value); scored = true; turnEnds = true; }
    else if (cmp === "chain") { gained += pointsFor(value); scored = true; }
    else { turnEnds = true; }
  }
  if (scored) {
    s.cellState[idx] = 2;
    gained += applyBingos(s, idx);
  }
  s.score += gained;
  if (turnEnds) s.handIdx += 1;
  return u;
}
function undoFlip(s, u) {
  s.cellState[u.idx] = 0;
  s.handIdx = u.prevHand;
  s.score = u.prevScore;
  s.bingosDone = u.prevBingos;
}

function applyCatch(s, idx, world) {
  const value = world[idx];
  const hand = HAND_SEQUENCE[s.handIdx];
  const cmp = compareHandVsRevealed(hand, value);
  if (cmp === "lose") return null;
  if (hand === "5") {
    // Real-game rule: any neighbour with true value 5 catches the 5-card,
    // regardless of its current revealed/scored state.
    for (const n of NEIGHBORS[idx]) if (world[n] === "5") return null;
  }
  const u = { idx, prevHand: s.handIdx, prevScore: s.score, prevBingos: s.bingosDone };
  s.cellState[idx] = 2;
  let gained = pointsFor(value);
  gained += applyBingos(s, idx);
  s.score += gained;
  if (cmp === "score") s.handIdx += 1;
  return u;
}
function undoCatch(s, u) {
  s.cellState[u.idx] = 1;
  s.handIdx = u.prevHand;
  s.score = u.prevScore;
  s.bingosDone = u.prevBingos;
}

// Optimistic upper bound on additional score from this state.
function ceiling(s, world) {
  const remainingHands = HAND_SEQUENCE.slice(s.handIdx);
  const canCatch = (v) => {
    for (const h of remainingHands) {
      const c = compareHandVsRevealed(h, v);
      if (c === "score" || c === "chain") return true;
    }
    return false;
  };
  let max = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    const st = s.cellState[i];
    if (st === 2) continue;
    const v = world[i];
    if (canCatch(v)) max += pointsFor(v);
  }
  let bingoCount = 0;
  for (let li = 0; li < BINGO_LINES.length; li++) if (s.bingosDone & (1 << li)) bingoCount++;
  max += (BINGO_LINES.length - bingoCount) * 10;
  return max;
}

let g_nodes = 0;
let g_cap = 0;

// Returns best final score reachable. With `goalShortCircuit=true`, returns as
// soon as any branch reaches GOAL_GOLD (faster yes/no for gold-rate).
function search(s, world, alpha, goalShortCircuit) {
  g_nodes++;
  if (g_nodes > g_cap) return s.score;
  if (s.handIdx >= HAND_SEQUENCE.length) return s.score;
  if (s.score + ceiling(s, world) <= alpha) return -Infinity;

  let best = s.score;
  const hand = HAND_SEQUENCE[s.handIdx];

  // Build ordered move list. Heuristics that *don't* sacrifice optimality:
  //   - Try chain-catches (continue turn, accumulate points) before terminal-catches.
  //   - Among catches of the same kind, higher value first (likelier to push past alpha).
  //   - Among flips: hand-match flips first, then chain flips by descending value,
  //     then losing flips last. During hand=5, skip flips that would flash AND
  //     skip flips of cells that would self-catch (any adjacent 5 in world).
  const catchChain = [];
  const catchScore = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (s.cellState[i] !== 1) continue;
    const v = world[i];
    const cmp = compareHandVsRevealed(hand, v);
    if (cmp === "lose") continue;
    if (hand === "5") {
      let blocked = false;
      for (const n of NEIGHBORS[i]) if (world[n] === "5") { blocked = true; break; }
      if (blocked) continue;
    }
    if (cmp === "chain") catchChain.push([i, pointsFor(v)]);
    else catchScore.push([i, pointsFor(v)]);
  }
  catchChain.sort((a, b) => b[1] - a[1]);
  catchScore.sort((a, b) => b[1] - a[1]);

  const flips = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (s.cellState[i] !== 0) continue;
    const v = world[i];
    // hand=5 specific pruning
    if (hand === "5") {
      // any face-down 5 adjacent = flash = wasted turn
      let flash = false;
      for (const n of NEIGHBORS[i]) {
        if (s.cellState[n] === 0 && world[n] === "5") { flash = true; break; }
      }
      if (flash) continue;
      // flipping a 5 with another 5 nearby = same wasted turn (handled above);
      // a lone 5 scores 50 cleanly — keep it.
    }
    const cmp = compareHandVsRevealed(hand, v);
    let bucket;
    if (cmp === "score") bucket = 0;
    else if (cmp === "chain") bucket = 1;
    else bucket = 2; // lose: still legal (reveal info), but rarely optimal late
    flips.push([i, bucket, pointsFor(v)]);
  }
  flips.sort((a, b) => a[1] - b[1] || b[2] - a[2]);

  // Try in order: chain catches → score catches → flips.
  for (const [i] of catchChain) {
    const u = applyCatch(s, i, world); if (!u) continue;
    const v = search(s, world, alpha, goalShortCircuit); undoCatch(s, u);
    if (v > best) best = v; if (v > alpha) alpha = v;
    if (goalShortCircuit && alpha >= GOAL_GOLD) return alpha;
  }
  for (const [i] of catchScore) {
    const u = applyCatch(s, i, world); if (!u) continue;
    const v = search(s, world, alpha, goalShortCircuit); undoCatch(s, u);
    if (v > best) best = v; if (v > alpha) alpha = v;
    if (goalShortCircuit && alpha >= GOAL_GOLD) return alpha;
  }
  for (const [i] of flips) {
    const u = applyFlip(s, i, world);
    const v = search(s, world, alpha, goalShortCircuit); undoFlip(s, u);
    if (v > best) best = v; if (v > alpha) alpha = v;
    if (goalShortCircuit && alpha >= GOAL_GOLD) return alpha;
  }
  return best;
}

function solveBoard(world, nodeCap, goalShortCircuit) {
  g_nodes = 0;
  g_cap = nodeCap;
  const s = makeState();
  const score = search(s, world, -Infinity, goalShortCircuit);
  return { score, nodes: g_nodes, exhausted: g_nodes > g_cap };
}

function fmtPct(x) { return (x * 100).toFixed(1) + "%"; }

function main() {
  const n = Number(process.argv[2] ?? 1000);
  const cap = Number(process.argv[3] ?? 2_000_000);
  const goalOnly = (process.argv[4] === "gold"); // shortcut: just decide gold-yes/no
  console.log(`Perfect-info ceiling: ${n} boards · cap ${cap.toLocaleString()} nodes/board · mode=${goalOnly ? "gold-only" : "full-max"}`);
  const t0 = Date.now();
  let gold = 0, silver = 0, bronze = 0, sumScore = 0, exhausted = 0;
  let maxNodes = 0, sumNodes = 0;
  const buckets = { "<100": 0, "100-399": 0, "400-549": 0, "550+": 0 };
  for (let i = 0; i < n; i++) {
    const r = solveBoard(randomBoard(), cap, goalOnly);
    if (r.score >= 550) gold++;
    if (r.score >= 400) silver++;
    if (r.score >= 100) bronze++;
    if (r.exhausted) exhausted++;
    sumScore += r.score;
    sumNodes += r.nodes;
    if (r.nodes > maxNodes) maxNodes = r.nodes;
    if (r.score < 100) buckets["<100"]++;
    else if (r.score < 400) buckets["100-399"]++;
    else if (r.score < 550) buckets["400-549"]++;
    else buckets["550+"]++;
    if ((i + 1) % 25 === 0) {
      const dt = (Date.now() - t0) / 1000;
      const eta = (dt / (i + 1)) * (n - i - 1);
      process.stdout.write(`\r  ${i + 1}/${n}  ${dt.toFixed(1)}s  ETA ${eta.toFixed(0)}s  exh=${exhausted}  maxNodes=${maxNodes.toLocaleString()}     `);
    }
  }
  process.stdout.write(`\r${" ".repeat(80)}\r`);
  const dt = (Date.now() - t0) / 1000;
  console.log(`Done in ${dt.toFixed(1)}s  (avg nodes/board ${(sumNodes / n).toFixed(0)}, max ${maxNodes.toLocaleString()})`);
  console.log("");
  console.log(`Boards: ${n}`);
  console.log(`Gold   ceiling: ${fmtPct(gold / n)}`);
  console.log(`Silver ceiling: ${fmtPct(silver / n)}`);
  console.log(`Bronze ceiling: ${fmtPct(bronze / n)}`);
  console.log(`Mean    score:  ${(sumScore / n).toFixed(1)}`);
  console.log(`Node-cap exhausted on ${exhausted} board(s) — those are LOWER bounds, not the true ceiling.`);
  console.log("");
  for (const k of ["<100", "100-399", "400-549", "550+"]) {
    console.log(`  ${k.padEnd(9)}  ${buckets[k]}  (${fmtPct(buckets[k] / n)})`);
  }
}

main();
