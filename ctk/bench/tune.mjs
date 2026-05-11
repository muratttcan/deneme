// Random-search weight tuner for solver.js.
//
// Stage 1: sample N candidate configs from wide ranges around the defaults,
//          evaluate each on the SAME set of random boards (paired comparison
//          crushes variance — same luck across all configs).
// Stage 2: re-evaluate the top K configs on a fresh, larger board set so we
//          don't just reward configs that got lucky on stage 1's boards.
//
// Usage:  node tune.mjs [configs] [gamesPerConfigStage1] [gamesPerConfigStage2]
// Default: 80 configs · 600 games · 3000 games. Runs in a couple of minutes.

import {
  createState,
  recordReveal,
  catchCell,
  isGameOver,
  NEIGHBORS,
  CELL_COUNT,
  BOARD_COUNTS,
} from "../game.js";
import { suggestMove, DEFAULT_WEIGHTS } from "../solver.js";

// ---------- seeded RNG + board generation ----------

// mulberry32 — tiny, deterministic, good enough for Monte Carlo.
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
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function randomBoard(rng) {
  const values = [];
  for (const v of Object.keys(BOARD_COUNTS)) {
    for (let i = 0; i < BOARD_COUNTS[v]; i++) values.push(v);
  }
  shuffleWith(values, rng);
  return values;
}

function generateBoards(n, seed) {
  const rng = mulberry32(seed);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = randomBoard(rng);
  return out;
}

// ---------- self-play ----------

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

function evaluateConfig(weights, boards) {
  let gold = 0;
  let silver = 0;
  let sum = 0;
  for (const b of boards) {
    const s = playOneGame(b, weights);
    if (s >= 550) gold += 1;
    if (s >= 400) silver += 1;
    sum += s;
  }
  const n = boards.length;
  return { pGold: gold / n, pSilver: silver / n, mean: sum / n, n };
}

// ---------- search space ----------
//
// Narrowed after pass 1: ranges bracket the top-8 configs from the first
// sweep, slightly widened on each side. `centerTiebreak` and `kHuntSlope`
// showed weak signal (winners span their whole range) so we keep those
// wide-ish. The intensified search should push into the 40%+ region faster.
// `spreadWeight` was added with the dominating-set opener; we sweep it from
// 0 (off) up to a generous ceiling.
function sampleConfig(rng) {
  // Per-phase sampler: independent draws for early/mid/late so the tuner can
  // discover phase-specific tradeoffs (e.g. higher info in early, higher
  // K-hunt in late) that a single-config search has to average out.
  const perPhase = (lo, hi) => ({
    early: lo + rng() * (hi - lo),
    mid:   lo + rng() * (hi - lo),
    late:  lo + rng() * (hi - lo),
  });
  return {
    catchPenalty:   400 + rng() * 1200,  // hand=5 only — phase-flat
    centerTiebreak: rng() * 0.05,        // weak signal — phase-flat
    infoWeight:     perPhase(8, 36),     // bits-scale, prior sweet spot 15–30
    chainBonusMul:  perPhase(1.2, 2.6),  // chain-continuation EV mul
    kHuntBase:      perPhase(0, 320),    // K-hunt floor
    kHuntSlope:     perPhase(0, 3.5),    // gap-scaled slope
    kHuntMax:       perPhase(400, 820),  // K-hunt ceiling
    spreadWeight:   perPhase(0, 8),      // board-coverage bonus
  };
}

function formatConfig(c) {
  const fmtScalar = (v) => Number(v).toFixed(3);
  const fmtPhase = (obj) => `{ early: ${fmtScalar(obj.early)}, mid: ${fmtScalar(obj.mid)}, late: ${fmtScalar(obj.late)} }`;
  const keys = Object.keys(DEFAULT_WEIGHTS);
  const parts = keys.map((k) => {
    const v = c[k];
    return `${k}: ${typeof v === "object" ? fmtPhase(v) : fmtScalar(v)}`;
  });
  return "{ " + parts.join(", ") + " }";
}

function stderr(p, n) {
  return Math.sqrt(p * (1 - p) / n);
}

// ---------- main ----------

function main() {
  const nConfigs = Number(process.argv[2] ?? 80);
  const nStage1  = Number(process.argv[3] ?? 600);
  const nStage2  = Number(process.argv[4] ?? 3000);
  const TOP_K    = 8;

  console.log(`Tuning heuristic solver`);
  console.log(`  configs:       ${nConfigs}  (+1 baseline)`);
  console.log(`  stage 1 games: ${nStage1}`);
  console.log(`  stage 2 games: ${nStage2} (top ${TOP_K})`);
  console.log("");

  const rng = mulberry32(20260424);
  const configs = [DEFAULT_WEIGHTS];
  for (let i = 0; i < nConfigs; i++) configs.push(sampleConfig(rng));

  // ----- stage 1 -----
  const stage1Boards = generateBoards(nStage1, 0x5EED1);
  const t0 = Date.now();
  const stage1 = [];
  for (let i = 0; i < configs.length; i++) {
    const stats = evaluateConfig(configs[i], stage1Boards);
    stage1.push({ config: configs[i], stats, baseline: i === 0 });
    const done = i + 1;
    const dt = (Date.now() - t0) / 1000;
    const eta = (dt / done) * (configs.length - done);
    process.stdout.write(
      `\r  stage 1:  ${done}/${configs.length}  ${dt.toFixed(1)}s elapsed  ETA ${eta.toFixed(0)}s    `,
    );
  }
  process.stdout.write(`\r${" ".repeat(70)}\r`);
  console.log(`Stage 1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  stage1.sort((a, b) => b.stats.pGold - a.stats.pGold);

  const baselineS1 = stage1.find((r) => r.baseline).stats;
  console.log("");
  console.log(`Stage 1 baseline: pGold=${(baselineS1.pGold*100).toFixed(1)}%  pSilver=${(baselineS1.pSilver*100).toFixed(1)}%  mean=${baselineS1.mean.toFixed(0)}`);

  console.log("");
  console.log(`Stage 1 top ${TOP_K}:`);
  for (let i = 0; i < Math.min(TOP_K, stage1.length); i++) {
    const r = stage1[i];
    const tag = r.baseline ? " [baseline]" : "";
    console.log(`  ${(i+1).toString().padStart(2)}. pGold=${(r.stats.pGold*100).toFixed(1)}% pSilver=${(r.stats.pSilver*100).toFixed(1)}% mean=${r.stats.mean.toFixed(0)}${tag}`);
  }

  // ----- stage 2 -----
  console.log("");
  console.log(`Stage 2: re-evaluating top ${TOP_K} on ${nStage2} fresh boards…`);
  const stage2Boards = generateBoards(nStage2, 0xB00B5);
  const t1 = Date.now();
  const pool = stage1.slice(0, TOP_K).map((r) => r.config);
  // Always include baseline in stage 2 as the reference line.
  if (!pool.some((c) => c === DEFAULT_WEIGHTS)) pool.push(DEFAULT_WEIGHTS);

  const stage2 = [];
  for (let i = 0; i < pool.length; i++) {
    const stats = evaluateConfig(pool[i], stage2Boards);
    stage2.push({ config: pool[i], stats, baseline: pool[i] === DEFAULT_WEIGHTS });
    const dt = (Date.now() - t1) / 1000;
    process.stdout.write(`\r  stage 2:  ${i+1}/${pool.length}  ${dt.toFixed(1)}s elapsed    `);
  }
  process.stdout.write(`\r${" ".repeat(70)}\r`);
  console.log(`Stage 2 done in ${((Date.now() - t1) / 1000).toFixed(1)}s.`);

  stage2.sort((a, b) => b.stats.pGold - a.stats.pGold);

  console.log("");
  console.log(`Stage 2 results (n=${nStage2}):`);
  for (let i = 0; i < stage2.length; i++) {
    const r = stage2[i];
    const se = stderr(r.stats.pGold, nStage2) * 100;
    const tag = r.baseline ? " [baseline]" : "";
    console.log(`  ${(i+1).toString().padStart(2)}. pGold=${(r.stats.pGold*100).toFixed(1)}% ±${se.toFixed(1)}  pSilver=${(r.stats.pSilver*100).toFixed(1)}%  mean=${r.stats.mean.toFixed(0)}${tag}`);
    console.log(`      ${formatConfig(r.config)}`);
  }

  const winner = stage2[0];
  const baselineS2 = stage2.find((r) => r.baseline).stats;
  console.log("");
  console.log("=".repeat(68));
  console.log(`Baseline pGold: ${(baselineS2.pGold*100).toFixed(1)}%`);
  console.log(`Winner pGold:   ${(winner.stats.pGold*100).toFixed(1)}%`);
  const delta = (winner.stats.pGold - baselineS2.pGold) * 100;
  console.log(`Delta:          ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} points`);
  if (!winner.baseline) {
    console.log("");
    console.log("Copy this into DEFAULT_WEIGHTS in solver.js if you like it:");
    console.log(JSON.stringify(winner.config, null, 2));
  }
}

main();
