// A/B: policy-rollout PIMC vs heuristic baseline. Paired self-play.
//
// Cost is high — start with small n and small N. If the signal is positive,
// raise n to nail the SE down.
//
// Usage: node ctk/bench-policy-rollout.mjs [games] [seed] [N rollouts]

import {
  createState,
  recordReveal,
  catchCell,
  isGameOver,
  NEIGHBORS,
  BOARD_COUNTS,
} from "../game.js";
import { suggestMove, DEFAULT_WEIGHTS } from "../solver.js";
import { suggestMovePolicyRollout } from "../simulate.js";

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

function playOneGameHeuristic(world) {
  const state = createState();
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    const s = suggestMove(state, DEFAULT_WEIGHTS);
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

function playOneGamePolicyRollout(world, N) {
  const state = createState();
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    const s = suggestMovePolicyRollout(state, { N });
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

function evaluate(playFn, boards, label) {
  let gold = 0, silver = 0, sum = 0;
  const t0 = Date.now();
  for (let i = 0; i < boards.length; i++) {
    const s = playFn(boards[i]);
    if (s >= 550) gold += 1;
    if (s >= 400) silver += 1;
    sum += s;
    if (true) {
      const dt = (Date.now() - t0) / 1000;
      const eta = (dt / (i + 1)) * (boards.length - i - 1);
      process.stdout.write(`  ${label}: ${i+1}/${boards.length}  ${dt.toFixed(0)}s  ETA ${eta.toFixed(0)}s\n`);
    }
  }
  const n = boards.length;
  return { pGold: gold / n, pSilver: silver / n, mean: sum / n, n, t: (Date.now() - t0) / 1000 };
}

function main() {
  const N_GAMES = Number(process.argv[2] ?? 100);
  const seed = Number(process.argv[3] ?? 0xB14660);
  const N_ROLLOUTS = Number(process.argv[4] ?? 50);
  const boards = generateBoards(N_GAMES, seed);
  console.log(`Policy-rollout PIMC A/B — n=${N_GAMES} games, seed=${seed.toString(16)}, N=${N_ROLLOUTS} rollouts/decision`);
  console.log("");

  console.log("baseline (heuristic):");
  const baseline = evaluate(playOneGameHeuristic, boards, "heur");
  console.log("");
  console.log("policy-rollout:");
  const pr = evaluate((w) => playOneGamePolicyRollout(w, N_ROLLOUTS), boards, "PR");

  console.log("");
  console.log("Results:");
  const fmt = (label, r) => {
    const se = Math.sqrt(r.pGold * (1 - r.pGold) / r.n) * 100;
    return `  ${label.padEnd(16)} pGold=${(r.pGold*100).toFixed(2)}% ±${se.toFixed(2)}  pSilver=${(r.pSilver*100).toFixed(2)}%  mean=${r.mean.toFixed(0)}  ${(r.t).toFixed(0)}s (${(r.n/r.t).toFixed(1)} g/s)`;
  };
  console.log(fmt("baseline", baseline));
  console.log(fmt("policy-rollout", pr));
  const delta = (pr.pGold - baseline.pGold) * 100;
  const seDiff = Math.sqrt(
    (baseline.pGold * (1 - baseline.pGold) + pr.pGold * (1 - pr.pGold)) / N_GAMES,
  ) * 100;
  console.log(`  Δ pGold = ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp  (unpaired SE ≈ ${seDiff.toFixed(2)})`);
  console.log(`  slowdown: ${(pr.t / baseline.t).toFixed(1)}×`);
}
main();
