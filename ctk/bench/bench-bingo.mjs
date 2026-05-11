// 1D sweep over bingoProgressWeight: phase-flat values evaluated against
// the current DEFAULT_WEIGHTS baseline on the SAME paired board set so we
// can compare cleanly without per-config noise.
//
// Usage: node ctk/bench-bingo.mjs [games] [seed] [csv-of-weights]

import {
  createState,
  recordReveal,
  catchCell,
  isGameOver,
  NEIGHBORS,
  BOARD_COUNTS,
} from "../game.js";
import { suggestMove, DEFAULT_WEIGHTS } from "../solver.js";

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

function playOneGame(world, weights) {
  const state = createState();
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    const s = suggestMove(state, weights);
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

function evaluate(weights, boards) {
  let gold = 0, silver = 0, sum = 0;
  for (const b of boards) {
    const s = playOneGame(b, weights);
    if (s >= 550) gold += 1;
    if (s >= 400) silver += 1;
    sum += s;
  }
  const n = boards.length;
  return { pGold: gold / n, pSilver: silver / n, mean: sum / n, n };
}

function withBingoW(value) {
  return {
    ...DEFAULT_WEIGHTS,
    bingoProgressWeight: { early: value, mid: value, late: value },
  };
}

function main() {
  const N = Number(process.argv[2] ?? 5000);
  const seed = Number(process.argv[3] ?? 0xB14660);
  const sweepArg = process.argv[4];
  const sweep = sweepArg ? sweepArg.split(",").map(Number) : [0, 2, 5, 10, 20, 40, 80];
  const boards = generateBoards(N, seed);
  console.log(`bingoProgressWeight sweep — paired self-play, n=${N}`);
  console.log(`  w=0 = no partial-line bonus.`);
  console.log("");
  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < sweep.length; i++) {
    const w = sweep[i];
    const r = evaluate(withBingoW(w), boards);
    results.push({ w, ...r });
    const dt = (Date.now() - t0) / 1000;
    const eta = (dt / (i + 1)) * (sweep.length - i - 1);
    process.stdout.write(`\r  ${i+1}/${sweep.length}  ${dt.toFixed(1)}s elapsed  ETA ${eta.toFixed(0)}s    `);
  }
  process.stdout.write(`\r${" ".repeat(60)}\r`);
  console.log("");
  console.log("Results:");
  const baseline = results.find((r) => r.w === 0) ?? results[0];
  for (const r of results) {
    const se = Math.sqrt(r.pGold * (1 - r.pGold) / r.n) * 100;
    const delta = (r.pGold - baseline.pGold) * 100;
    const tag = r === baseline ? " [baseline]" : "";
    console.log(
      `  w=${String(r.w).padStart(5)}  pGold=${(r.pGold*100).toFixed(2)}% ±${se.toFixed(2)}  pSilver=${(r.pSilver*100).toFixed(2)}%  mean=${r.mean.toFixed(0)}  Δ=${delta>=0?"+":""}${delta.toFixed(2)}pp${tag}`,
    );
  }
}
main();
