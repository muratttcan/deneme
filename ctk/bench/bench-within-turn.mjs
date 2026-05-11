// A/B bench: within-turn expectimax vs baseline (heuristic chainBonus).
// Both arms play the SAME boards so noise cancels.
//
// Usage: node ctk/bench-within-turn.mjs [games] [seed]

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

function playOneGame(world, options) {
  const state = createState();
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    const s = suggestMove(state, DEFAULT_WEIGHTS, options);
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
  const N = Number(process.argv[2] ?? 3000);
  const seed = Number(process.argv[3] ?? 0xB14660);
  const boards = generateBoards(N, seed);

  console.log(`Within-turn EV A/B — paired self-play, n=${N}, seed=${seed.toString(16)}`);
  console.log("");

  const t0 = Date.now();
  const baseline = evaluate({}, boards);
  const dt0 = (Date.now() - t0) / 1000;
  process.stdout.write(`baseline done in ${dt0.toFixed(1)}s\n`);

  const t1 = Date.now();
  const withinTurn = evaluate({ withinTurnEv: true }, boards);
  const dt1 = (Date.now() - t1) / 1000;
  process.stdout.write(`within-turn done in ${dt1.toFixed(1)}s\n`);

  console.log("");
  console.log("Results:");
  const fmt = (label, r) => {
    const se = Math.sqrt(r.pGold * (1 - r.pGold) / r.n) * 100;
    return `  ${label.padEnd(14)} pGold=${(r.pGold*100).toFixed(2)}% ±${se.toFixed(2)}  pSilver=${(r.pSilver*100).toFixed(2)}%  mean=${r.mean.toFixed(0)}`;
  };
  console.log(fmt("baseline", baseline));
  console.log(fmt("withinTurnEv", withinTurn));
  const delta = (withinTurn.pGold - baseline.pGold) * 100;
  const seDiff = Math.sqrt(
    (baseline.pGold * (1 - baseline.pGold) + withinTurn.pGold * (1 - withinTurn.pGold)) / N,
  ) * 100;
  console.log(`  Δ pGold = ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp  (unpaired SE ≈ ${seDiff.toFixed(2)})`);
  console.log(`  speed: baseline ${(N/dt0).toFixed(0)} g/s, within-turn ${(N/dt1).toFixed(0)} g/s (${(dt1/dt0).toFixed(1)}× slower)`);
}
main();
