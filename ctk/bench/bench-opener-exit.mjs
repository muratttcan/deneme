// Paired benchmark for the opener early-exit gate added in solver.js.
// Plays the SAME random board twice — once with the new gate active, once
// with it forced off (forceFullOpener) — so the comparison is paired and
// noise from board luck cancels.
//
// Usage:  node bench-opener-exit.mjs [games]

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

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

function randomBoard(rng) {
  const values = [];
  for (const v of Object.keys(BOARD_COUNTS)) {
    for (let i = 0; i < BOARD_COUNTS[v]; i++) values.push(v);
  }
  shuffleInPlace(values, rng);
  return values;
}

function playOneGame(world, options) {
  const state = createState();
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    const suggestion = suggestMove(state, undefined, options);
    if (!suggestion || suggestion.cellIdx == null) break;
    const idx = suggestion.cellIdx;
    const cell = state.cells[idx];
    if (cell.state === "hidden") {
      const value = world[idx];
      let flashed = false;
      for (const n of NEIGHBORS[idx]) {
        if (world[n] === "5") { flashed = true; break; }
      }
      recordReveal(state, idx, value, flashed);
    } else {
      const res = catchCell(state, idx);
      if (!res) break;
    }
  }
  return { score: state.score, bingos: state.completedBingos.size };
}

function summarize(scores) {
  const n = scores.length;
  const sorted = scores.slice().sort((a, b) => a - b);
  let gold = 0, silver = 0, sum = 0;
  for (const s of scores) {
    if (s >= 550) gold++;
    if (s >= 400) silver++;
    sum += s;
  }
  const mean = sum / n;
  let variance = 0;
  for (const s of scores) variance += (s - mean) ** 2;
  return {
    n,
    pGold: gold / n,
    pSilver: silver / n,
    mean,
    median: sorted[Math.floor(n / 2)],
    stdev: Math.sqrt(variance / n),
  };
}

function pct(x) { return (x * 100).toFixed(2) + "%"; }

function pairedBinomialCI(deltaCount, n) {
  // 95% CI on McNemar's paired proportion difference (normal approx).
  if (n === 0) return 0;
  const p = deltaCount / n;
  return 1.96 * Math.sqrt(Math.max(1e-9, p * (1 - p)) / n);
}

function main() {
  const n = Number(process.argv[2] ?? 1000);
  if (!Number.isFinite(n) || n <= 0) {
    console.error("usage: node bench-opener-exit.mjs [games]");
    process.exit(1);
  }
  // Use Math.random for board generation but each board is generated once
  // and replayed twice — pairing handles RNG variance. No seeding needed.
  console.log(`Paired self-play: ${n} boards × {new gate, forced full opener}…`);
  const t0 = Date.now();

  const baseScores = [];
  const newScores = [];
  let goldNewOnly = 0, goldBaseOnly = 0, goldBoth = 0, goldNeither = 0;
  let scoreDiffSum = 0;
  let scoreDiffSqSum = 0;

  for (let i = 0; i < n; i++) {
    const board = randomBoard(Math.random);
    const baseRes = playOneGame(board, { forceFullOpener: true });
    const newRes  = playOneGame(board, { forceFullOpener: false });
    baseScores.push(baseRes.score);
    newScores.push(newRes.score);
    const baseGold = baseRes.score >= 550;
    const newGold = newRes.score >= 550;
    if (newGold && !baseGold) goldNewOnly++;
    else if (!newGold && baseGold) goldBaseOnly++;
    else if (newGold && baseGold) goldBoth++;
    else goldNeither++;
    const d = newRes.score - baseRes.score;
    scoreDiffSum += d;
    scoreDiffSqSum += d * d;
    if ((i + 1) % 100 === 0) {
      const dt = (Date.now() - t0) / 1000;
      process.stdout.write(`\r  ${i + 1}/${n}  (${dt.toFixed(1)}s)   `);
    }
  }
  process.stdout.write(`\r                                       \r`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log("");

  const baseStats = summarize(baseScores);
  const newStats = summarize(newScores);

  console.log("                       baseline (full opener)   new gate (early-exit)");
  console.log(`  Gold   (≥550):       ${pct(baseStats.pGold).padStart(10)}                 ${pct(newStats.pGold).padStart(10)}`);
  console.log(`  Silver (≥400):       ${pct(baseStats.pSilver).padStart(10)}                 ${pct(newStats.pSilver).padStart(10)}`);
  console.log(`  Mean score:          ${baseStats.mean.toFixed(1).padStart(10)}                 ${newStats.mean.toFixed(1).padStart(10)}`);
  console.log(`  Median score:        ${String(baseStats.median).padStart(10)}                 ${String(newStats.median).padStart(10)}`);
  console.log(`  Stdev:               ${baseStats.stdev.toFixed(1).padStart(10)}                 ${newStats.stdev.toFixed(1).padStart(10)}`);
  console.log("");

  const goldDelta = newStats.pGold - baseStats.pGold;
  const ci = pairedBinomialCI(goldNewOnly + goldBaseOnly, n);
  console.log(`Gold rate Δ (new − baseline):  ${(goldDelta * 100 >= 0 ? "+" : "")}${(goldDelta * 100).toFixed(2)} pp`);
  console.log(`  Discordant pairs:  new-only=${goldNewOnly}  base-only=${goldBaseOnly}  (both=${goldBoth}, neither=${goldNeither})`);
  console.log(`  ~95% CI half-width on Δ:  ±${(ci * 100).toFixed(2)} pp`);
  console.log("");

  const meanDelta = scoreDiffSum / n;
  const varDelta = scoreDiffSqSum / n - meanDelta * meanDelta;
  const seDelta = Math.sqrt(Math.max(0, varDelta) / n);
  console.log(`Mean score Δ (new − baseline):  ${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(2)}  (SE ${seDelta.toFixed(2)},  ~95% CI ±${(1.96 * seDelta).toFixed(2)})`);
}

main();
