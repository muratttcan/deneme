// Paired A/B: late-game search with E[score] objective vs P(gold)-dominant
// objective. Same boards, just toggle the search's objective. Measures how
// much the gold-priority leaf moves the gold rate.
//
// Usage: node ctk/bench-goldobjective.mjs [games] [seed]

import {
  createState, recordReveal, catchCell, isGameOver,
  NEIGHBORS, BOARD_COUNTS, currentCard,
} from "../game.js";
import { suggestMove, DEFAULT_WEIGHTS } from "../solver.js";
import { suggestMoveSearch } from "../search.js";

const SEARCH_TRIGGER = 10;
const SEARCH_MAX_HIDDEN = 6;
const SEARCH_BUDGET = 50000;

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
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
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
function flashedFor(idx, world) {
  for (const n of NEIGHBORS[idx]) if (world[n] === "5") return true;
  return false;
}

// Custom playOne that overrides the search objective. We invoke
// suggestMove with a special hook... actually simpler: override at the
// search call site. The cleanest path is a custom play loop that
// reimplements the late-game branch with the chosen objective, falling
// through to suggestMove (with disableSearch=true equivalent — or we
// just skip the heuristic search trigger by checking conditions
// ourselves).
//
// Even simpler: rebuild the trigger logic here and use suggestMove
// only for non-search moves. Ugly but explicit.
function playOne(world, objective) {
  const state = createState();
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    // Force the search objective via the solver's hook.
    const s = suggestMove(state, undefined, { searchObjective: objective });
    if (!s || s.cellIdx == null) break;
    const idx = s.cellIdx;
    const cell = state.cells[idx];
    if (cell.state === "hidden") recordReveal(state, idx, world[idx], flashedFor(idx, world));
    else if (!catchCell(state, idx)) break;
  }
  return state.score;
}

function evaluate(objective, boards) {
  let gold = 0, silver = 0, sum = 0;
  for (const b of boards) {
    const s = playOne(b, objective);
    if (s >= 550) gold += 1;
    if (s >= 400) silver += 1;
    sum += s;
  }
  return { pGold: gold / boards.length, pSilver: silver / boards.length, mean: sum / boards.length, n: boards.length };
}

function main() {
  const N = Number(process.argv[2] ?? 8000);
  const seed = Number(process.argv[3] ?? 0xDEED);
  const boards = generateBoards(N, seed);
  console.log(`Gold-priority A/B — n=${N}, seed=0x${seed.toString(16)}`);
  console.log("");
  const t0 = Date.now();
  const a = evaluate("score", boards);
  const t1 = Date.now();
  const b = evaluate("gold", boards);
  const t2 = Date.now();
  const se = (p, n) => Math.sqrt(p * (1 - p) / n) * 100;
  console.log(`E[score] objective    pGold=${(a.pGold*100).toFixed(2)}% ±${se(a.pGold, N).toFixed(2)}  pSilver=${(a.pSilver*100).toFixed(2)}%  mean=${a.mean.toFixed(0)}  (${((t1-t0)/1000).toFixed(0)}s)`);
  console.log(`P(gold) objective     pGold=${(b.pGold*100).toFixed(2)}% ±${se(b.pGold, N).toFixed(2)}  pSilver=${(b.pSilver*100).toFixed(2)}%  mean=${b.mean.toFixed(0)}  (${((t2-t1)/1000).toFixed(0)}s)`);
  const delta = (b.pGold - a.pGold) * 100;
  console.log("");
  console.log(`Δ (gold - score):  ${delta>=0?"+":""}${delta.toFixed(2)}pp gold`);
}
main();
