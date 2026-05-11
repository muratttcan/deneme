// Offline benchmark: self-play N games using the heuristic solver against
// random boards, report gold/silver rates + score distribution.
//
// Usage:  node benchmark.mjs [games]
// Default: 500 games.
//
// This is the yardstick for improving the solver: tweak a weight in solver.js,
// re-run, compare gold/silver rates. A regression here is a regression for the
// user. It's also the thing we'll wrap in a grid/random search once we know
// which knobs actually matter.

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

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

// Random 25-value board matching the game's composition (7x1 4x2 5x3 5x4 3x5 1xK).
function randomBoard() {
  const values = [];
  for (const v of Object.keys(BOARD_COUNTS)) {
    for (let i = 0; i < BOARD_COUNTS[v]; i++) values.push(v);
  }
  shuffleInPlace(values);
  return values;
}

function kIndex(world) {
  for (let i = 0; i < CELL_COUNT; i++) if (world[i] === "K") return i;
  return -1;
}

// Play one game end-to-end: the solver sees only observed state, every reveal
// is resolved from `world` (with flash = any face-down 5 in world neighbours).
function playOneGame(world, options) {
  const state = createState();
  const kIdx = kIndex(world);
  let kRevealedBeforeKTurn = false;
  // Safety cap: ~25 flips + ~25 catches is the worst case; 200 is plenty.
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
      if (idx === kIdx && state.handIndex < 11) kRevealedBeforeKTurn = true;
    } else {
      // Catch. catchCell may legitimately refuse (e.g. unsafe hand=5 catch);
      // the solver's filters should prevent that, but if it does happen we
      // bail to avoid an infinite loop.
      const res = catchCell(state, idx);
      if (!res) break;
    }
  }
  return {
    score: state.score,
    bingos: state.completedBingos.size,
    kRevealedEarly: kRevealedBeforeKTurn,
  };
}

function summarize(results) {
  const n = results.length;
  const scores = results.map((r) => r.score).sort((a, b) => a - b);
  let gold = 0, silver = 0, bronze = 0, sum = 0, bingoSum = 0, kEarly = 0;
  const buckets = { "<100": 0, "100-399": 0, "400-549": 0, "550+": 0 };
  for (const r of results) {
    if (r.score >= 550) gold++;
    if (r.score >= 400) silver++;
    if (r.score >= 100) bronze++;
    sum += r.score;
    bingoSum += r.bingos;
    if (r.kRevealedEarly) kEarly++;
    if (r.score < 100) buckets["<100"]++;
    else if (r.score < 400) buckets["100-399"]++;
    else if (r.score < 550) buckets["400-549"]++;
    else buckets["550+"]++;
  }
  const mean = sum / n;
  let variance = 0;
  for (const s of scores) variance += (s - mean) ** 2;
  const stdev = Math.sqrt(variance / n);
  return {
    n,
    pGold: gold / n,
    pSilver: silver / n,
    pBronze: bronze / n,
    mean,
    median: scores[Math.floor(n / 2)],
    p10: scores[Math.floor(n * 0.1)],
    p90: scores[Math.floor(n * 0.9)],
    min: scores[0],
    max: scores[n - 1],
    stdev,
    avgBingos: bingoSum / n,
    pKEarly: kEarly / n,
    buckets,
  };
}

function printReport(stats) {
  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log("");
  console.log(`Games:           ${stats.n}`);
  console.log(`Gold   (≥550):   ${pct(stats.pGold)}`);
  console.log(`Silver (≥400):   ${pct(stats.pSilver)}`);
  console.log(`Bronze (≥100):   ${pct(stats.pBronze)}`);
  console.log(`K revealed pre-K-turn: ${pct(stats.pKEarly)}`);
  console.log("");
  console.log(`Score  mean:     ${stats.mean.toFixed(1)}`);
  console.log(`       median:   ${stats.median}`);
  console.log(`       p10/p90:  ${stats.p10} / ${stats.p90}`);
  console.log(`       stdev:    ${stats.stdev.toFixed(1)}`);
  console.log(`       range:    ${stats.min} – ${stats.max}`);
  console.log(`       avg bingos: ${stats.avgBingos.toFixed(2)}`);
  console.log("");
  const total = stats.n;
  const bar = (count) => {
    const filled = Math.round((count / total) * 40);
    return "█".repeat(filled) + "·".repeat(40 - filled);
  };
  for (const label of ["<100", "100-399", "400-549", "550+"]) {
    const c = stats.buckets[label];
    console.log(`  ${label.padEnd(9)} ${bar(c)}  ${c}  (${pct(c / total)})`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const fullOpener = args.includes("--full-opener");
  const positional = args.filter((a) => !a.startsWith("--"));
  const n = Number(positional[0] ?? 500);
  if (!Number.isFinite(n) || n <= 0) {
    console.error("usage: node benchmark.mjs [games] [--full-opener]");
    process.exit(1);
  }
  const openerArg = args.find((a) => a.startsWith("--opener="));
  const openerPattern = openerArg
    ? openerArg.slice("--opener=".length).split(",").map(Number)
    : null;
  const opts = (fullOpener || openerPattern) ? {} : undefined;
  if (fullOpener) opts.forceFullOpener = true;
  if (openerPattern) opts.openerPattern = openerPattern;
  const tag = [
    fullOpener ? " (forced full opener — early-exit disabled)" : "",
    openerPattern ? ` (opener=[${openerPattern.join(",")}])` : "",
  ].join("");
  console.log(`Self-playing ${n} games with the heuristic solver${tag}…`);
  const t0 = Date.now();
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(playOneGame(randomBoard(), opts));
    if ((i + 1) % 50 === 0) {
      const dt = (Date.now() - t0) / 1000;
      process.stdout.write(`\r  ${i + 1}/${n}  (${dt.toFixed(1)}s)   `);
    }
  }
  const dt = (Date.now() - t0) / 1000;
  process.stdout.write(`\r                                       \r`);
  console.log(`Done in ${dt.toFixed(1)}s (${(dt * 1000 / n).toFixed(1)} ms/game).`);
  printReport(summarize(results));
}

main();
