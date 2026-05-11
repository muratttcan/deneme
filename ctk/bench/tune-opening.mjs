// Opening-move tester. For each named strategy, force the first few flips to
// a fixed cell sequence and let the heuristic play out the rest. Same board
// sequence (seeded) is used for every strategy so the comparison is paired —
// the variance of "did this game's K end up easy?" cancels.
//
// Usage:  node tune-opening.mjs [games]
// Default: 10,000.

import {
  createState,
  recordReveal,
  catchCell,
  isGameOver,
  NEIGHBORS,
  CELL_COUNT,
  BOARD_COUNTS,
} from "../game.js";
import { suggestMove } from "../solver.js";

// ---------- seeded RNG + boards ----------
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWith(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

function randomBoard(rng) {
  const v = [];
  for (const k of Object.keys(BOARD_COUNTS)) for (let i = 0; i < BOARD_COUNTS[k]; i++) v.push(k);
  shuffleWith(v, rng);
  return v;
}

function generateBoards(n, seed) {
  const rng = mulberry32(seed);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = randomBoard(rng);
  return out;
}

// ---------- self-play with optional forced opening ----------
function flashedFor(idx, world) {
  for (const n of NEIGHBORS[idx]) if (world[n] === "5") return true;
  return false;
}

function playGame(world, opening) {
  const state = createState();
  let openIdx = 0;
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    // Drain already-revealed forced cells.
    while (openIdx < opening.length && state.cells[opening[openIdx]].state !== "hidden") openIdx += 1;
    if (openIdx < opening.length) {
      const idx = opening[openIdx++];
      recordReveal(state, idx, world[idx], flashedFor(idx, world));
      continue;
    }
    const sug = suggestMove(state);
    if (!sug || sug.cellIdx == null) break;
    const idx = sug.cellIdx;
    const cell = state.cells[idx];
    if (cell.state === "hidden") {
      recordReveal(state, idx, world[idx], flashedFor(idx, world));
    } else {
      if (!catchCell(state, idx)) break;
    }
  }
  return state.score;
}

// ---------- evaluation ----------
function evaluateStrategy(opening, boards) {
  let gold = 0, silver = 0, bronze = 0, sum = 0;
  for (const board of boards) {
    const s = playGame(board, opening);
    if (s >= 550) gold += 1;
    else if (s >= 400) silver += 1;
    else if (s >= 100) bronze += 1;
    sum += s;
  }
  const n = boards.length;
  return { pGold: gold / n, pSilver: silver / n, pBronze: bronze / n, mean: sum / n, n };
}

// Hand-picked candidates: status quo, the originals, plus extra dominating
// sets that cover all 25 cells with 4 reveals. {1,3,16,18}, {6,8,16,18},
// {6,8,21,23} all dominate; mirror copies should match by board symmetry.
const FIXED_STRATEGIES = [
  { name: "Status quo (solver decides)",        opening: [] },
  { name: "Centre-first  C-N-S-E (12,6,18,14)", opening: [12, 6, 18, 14] },
  { name: "Corners       NW-NE-SW-SE",          opening: [0, 4, 20, 24] },
  { name: "Diamond       C+4 corners",          opening: [12, 0, 4, 20, 24] },
  { name: "Plus          C+4 cardinals",        opening: [12, 2, 10, 14, 22] },
  { name: "User R1C2 R1C4 R4C2 R4C4 [1,3,16,18]", opening: [1, 3, 16, 18] },
  { name: "Inner-shifted [6,8,16,18]",          opening: [6, 8, 16, 18] },
  { name: "Inner-bottom  [6,8,21,23]",          opening: [6, 8, 21, 23] },
  { name: "User mirror   [6,8,21,23] reversed", opening: [21, 23, 6, 8] },
  { name: "Edge mids     [2,10,14,22]",         opening: [2, 10, 14, 22] },
  { name: "Inner cross   [7,11,13,17]",         opening: [7, 11, 13, 17] },
  { name: "User x order  [16,18,1,3]",          opening: [16, 18, 1, 3] },
];

function mulberry32_(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOpening(rng, length = 4) {
  const cells = [];
  const used = new Set();
  while (cells.length < length) {
    const c = Math.floor(rng() * CELL_COUNT);
    if (used.has(c)) continue;
    used.add(c);
    cells.push(c);
  }
  return cells;
}

function buildStrategies(randomCount) {
  const out = [...FIXED_STRATEGIES];
  // Use a SEPARATE seed from the board generator so we don't accidentally
  // correlate random openings with a particular board sequence.
  const rng = mulberry32_(0xBADCAFE);
  for (let i = 0; i < randomCount; i++) {
    const op = randomOpening(rng, 4);
    out.push({ name: `Random [${op.join(",")}]`, opening: op });
  }
  return out;
}

const STRATEGIES = buildStrategies(20);

function pct(x) { return (x * 100).toFixed(1) + "%"; }
function se(p, n) { return (Math.sqrt(p * (1 - p) / n) * 100).toFixed(1); }

function main() {
  const n = Number(process.argv[2] ?? 10000);
  console.log(`Opening tester — ${STRATEGIES.length} strategies × ${n} games each, paired boards.`);
  console.log("");

  const boards = generateBoards(n, 0xC0FFEE);
  const t0 = Date.now();
  const results = [];
  for (let i = 0; i < STRATEGIES.length; i++) {
    const s = STRATEGIES[i];
    const stats = evaluateStrategy(s.opening, boards);
    results.push({ ...s, stats });
    const dt = (Date.now() - t0) / 1000;
    process.stdout.write(`\r  ${i + 1}/${STRATEGIES.length}  ${dt.toFixed(1)}s elapsed   `);
  }
  process.stdout.write(`\r${" ".repeat(60)}\r`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log("");

  // Sort by gold rate.
  results.sort((a, b) => b.stats.pGold - a.stats.pGold);

  const baseline = results.find((r) => r.opening.length === 0).stats;

  // Header.
  const W_NAME = 38;
  console.log(
    "Strategy".padEnd(W_NAME) +
    "  Gold".padEnd(15) +
    "  Silver".padEnd(13) +
    "  Bronze".padEnd(13) +
    "  Mean   Δgold",
  );
  console.log("─".repeat(W_NAME + 15 + 13 + 13 + 14));
  for (const r of results) {
    const g = r.stats.pGold;
    const dg = (g - baseline.pGold) * 100;
    const dgStr = (dg >= 0 ? "+" : "") + dg.toFixed(1);
    console.log(
      r.name.padEnd(W_NAME) +
      `  ${pct(g)} ±${se(g, r.stats.n).padStart(3)}`.padEnd(15) +
      `  ${pct(r.stats.pSilver)}`.padEnd(13) +
      `  ${pct(r.stats.pBronze)}`.padEnd(13) +
      `  ${r.stats.mean.toFixed(0).padStart(4)}   ${dgStr}`,
    );
  }
  console.log("");
  const winner = results[0];
  if (winner.opening.length === 0) {
    console.log("Winner: status quo — no forced opening beats the solver's own first moves.");
  } else {
    console.log(`Winner: ${winner.name}  (Δgold = ${((winner.stats.pGold - baseline.pGold) * 100).toFixed(1)} pts vs status quo).`);
  }
}

main();
