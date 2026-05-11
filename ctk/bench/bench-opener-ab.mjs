// A/B: solver with the hardcoded [1,3,16,18] opener vs solver letting
// the heuristic pick from move 1. Paired self-play, same boards, both
// configs.
//
// Usage: node ctk/bench-opener-ab.mjs [games] [seed]

import {
  createState,
  recordReveal,
  catchCell,
  isGameOver,
  NEIGHBORS,
  BOARD_COUNTS,
} from "../game.js";
import { suggestMove } from "../solver.js";

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

function playOneGame(world, options) {
  const state = createState();
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    const s = suggestMove(state, undefined, options);
    if (!s || s.cellIdx == null) break;
    const idx = s.cellIdx;
    const cell = state.cells[idx];
    if (cell.state === "hidden") {
      const v = world[idx];
      let flashed = false;
      for (const n of NEIGHBORS[idx]) if (world[n] === "5") { flashed = true; break; }
      recordReveal(state, idx, v, flashed);
    } else {
      if (!catchCell(state, idx)) break;
    }
  }
  return state.score;
}

function evaluate(options, boards) {
  let gold = 0, silver = 0, sum = 0;
  for (const b of boards) {
    const s = playOneGame(b, options);
    if (s >= 550) gold += 1;
    if (s >= 400) silver += 1;
    sum += s;
  }
  const n = boards.length;
  return { pGold: gold / n, pSilver: silver / n, mean: sum / n, n };
}

function main() {
  const N = Number(process.argv[2] ?? 8000);
  const seed = Number(process.argv[3] ?? 0xABBA);
  const boards = generateBoards(N, seed);
  console.log(`Opener A/B — n=${N}, seed=0x${seed.toString(16)}`);
  console.log("");
  const t0 = Date.now();
  const withOpener = evaluate(undefined, boards);
  const t1 = Date.now();
  const withoutOpener = evaluate({ disableOpener: true }, boards);
  const t2 = Date.now();
  const se = (p, n) => Math.sqrt(p * (1 - p) / n) * 100;
  console.log(`with hardcoded opener  pGold=${(withOpener.pGold*100).toFixed(2)}% ±${se(withOpener.pGold, N).toFixed(2)}  pSilver=${(withOpener.pSilver*100).toFixed(2)}%  mean=${withOpener.mean.toFixed(0)}  (${((t1-t0)/1000).toFixed(0)}s)`);
  console.log(`heuristic from move 1  pGold=${(withoutOpener.pGold*100).toFixed(2)}% ±${se(withoutOpener.pGold, N).toFixed(2)}  pSilver=${(withoutOpener.pSilver*100).toFixed(2)}%  mean=${withoutOpener.mean.toFixed(0)}  (${((t2-t1)/1000).toFixed(0)}s)`);
  const delta = (withoutOpener.pGold - withOpener.pGold) * 100;
  console.log("");
  console.log(`Δ (heuristic - opener):  ${delta>=0?"+":""}${delta.toFixed(2)}pp gold`);
}
main();
