// A/B: shipped opener [6,8,16,18] vs. Hanfred's [6,9,21,24]. Paired self-play,
// same boards, same solver. Doubles as the headline chest-rate measurement
// for the shipped opener (the 'current' arm reports per-band distribution +
// score moments at high n).
//
// Usage: node ctk/bench/bench-opener-hanfred.mjs [games] [seed]
// Default: 10000 games, seed 0xC0FFEE.

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

function evaluate(name, options, boards) {
  const scores = new Array(boards.length);
  let gold = 0, silver = 0, bronze = 0, sub100 = 0, sum = 0;
  const t0 = Date.now();
  for (let i = 0; i < boards.length; i++) {
    const s = playOneGame(boards[i], options);
    scores[i] = s;
    sum += s;
    if (s >= 550) gold += 1;
    else if (s >= 400) silver += 1;
    else if (s >= 100) bronze += 1;
    else sub100 += 1;
    if ((i + 1) % 1000 === 0) {
      const dt = (Date.now() - t0) / 1000;
      process.stderr.write(`\r  [${name}] ${i + 1}/${boards.length}  (${dt.toFixed(0)}s)        `);
    }
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");
  scores.sort((a, b) => a - b);
  const n = boards.length;
  const mean = sum / n;
  const median = scores[Math.floor(n / 2)];
  const p10 = scores[Math.floor(n * 0.1)];
  const p90 = scores[Math.floor(n * 0.9)];
  let varSum = 0;
  for (const s of scores) varSum += (s - mean) ** 2;
  const stdev = Math.sqrt(varSum / n);
  const dt = (Date.now() - t0) / 1000;
  return {
    n,
    pGold: gold / n,
    pSilverBand: silver / n,
    pBronzeBand: bronze / n,
    pSub100: sub100 / n,
    mean, median, p10, p90, stdev,
    dt,
  };
}

const PATTERNS = {
  current: [6, 8, 16, 18],
  hanfred: [6, 9, 21, 24],
};

function fmtArm(name, r) {
  const sePct = (p) => Math.sqrt(p * (1 - p) / r.n) * 100;
  return [
    `${name.padEnd(8)} n=${r.n}  (${r.dt.toFixed(0)}s)`,
    `  Gold     (≥550)   ${(r.pGold*100).toFixed(2)}% ±${sePct(r.pGold).toFixed(2)}`,
    `  Silver   (400-549) ${(r.pSilverBand*100).toFixed(2)}%`,
    `  Bronze   (100-399) ${(r.pBronzeBand*100).toFixed(2)}%`,
    `  <100              ${(r.pSub100*100).toFixed(2)}%`,
    `  mean=${r.mean.toFixed(1)}  median=${r.median}  p10/p90=${r.p10}/${r.p90}  stdev=${r.stdev.toFixed(1)}`,
  ].join("\n");
}

function main() {
  const N = Number(process.argv[2] ?? 10000);
  const seed = Number(process.argv[3] ?? 0xC0FFEE);
  const boards = generateBoards(N, seed);
  console.log(`Opener A/B — n=${N}, seed=0x${seed.toString(16)}`);
  console.log(`current: [${PATTERNS.current.join(",")}]`);
  console.log(`hanfred: [${PATTERNS.hanfred.join(",")}]`);
  console.log("");

  const results = {};
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    results[name] = evaluate(name, { openerPattern: pattern, forceFullOpener: true }, boards);
    console.log(fmtArm(name, results[name]));
    console.log("");
  }
  const delta = (results.hanfred.pGold - results.current.pGold) * 100;
  const sePaired = Math.sqrt(
    (results.current.pGold * (1 - results.current.pGold) +
     results.hanfred.pGold * (1 - results.hanfred.pGold)) / N,
  ) * 100;
  const z = delta / sePaired;
  console.log(`Δ (hanfred - current):  ${delta>=0?"+":""}${delta.toFixed(2)}pp gold   z=${z.toFixed(2)}`);
}
main();
