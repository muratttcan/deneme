// Regret analysis: for each face-down reveal move the solver makes,
// replay the game from that point with the SECOND-best hidden cell,
// then continue with the normal solver. Measure how the swap changes
// final score, aggregated by hand.
//
// Output: per hand, mean regret (positive = solver was right) and the
// fraction of moves where the swap would have flipped gold↔not-gold.
//
// Usage: node ctk/bench-regret.mjs [games] [seed]

import {
  createState,
  recordReveal,
  catchCell,
  isGameOver,
  currentCard,
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

// Apply one suggestion to a state against `world`. Returns true if the
// game ended cleanly (or is still progressing), false on hard error.
function applyOne(state, world, suggestion) {
  const idx = suggestion.cellIdx;
  const cell = state.cells[idx];
  if (cell.state === "hidden") {
    const v = world[idx];
    let flashed = false;
    for (const n of NEIGHBORS[idx]) if (world[n] === "5") { flashed = true; break; }
    recordReveal(state, idx, v, flashed);
    return true;
  }
  return catchCell(state, idx) ? true : false;
}

// Play to completion using normal suggestMove. Returns final score.
function playToEnd(state, world) {
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    const s = suggestMove(state);
    if (!s || s.cellIdx == null) break;
    if (!applyOne(state, world, s)) break;
  }
  return state.score;
}

// Play one game, returning final score AND for every face-down-reveal
// move, the (handAtMove, secondBestCellIdx) so we can replay swaps.
function playWithLogging(world) {
  const state = createState();
  const moveLog = []; // { stateBefore, hand, secondBest }
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    const hand = currentCard(state);
    const s = suggestMove(state, undefined, { allCandidates: true });
    if (!s || s.cellIdx == null) break;
    // Only log moves that are face-down reveals with a real second-best.
    const cell = state.cells[s.cellIdx];
    if (cell.state === "hidden" && s.rankedHidden && s.rankedHidden.length >= 2) {
      const second = s.rankedHidden.find((r) => r.cellIdx !== s.cellIdx);
      if (second) {
        moveLog.push({
          stateBefore: structuredClone(state),
          hand,
          chosen: s.cellIdx,
          secondBest: second.cellIdx,
        });
      }
    }
    if (!applyOne(state, world, s)) break;
  }
  return { score: state.score, moveLog };
}

// For one logged move, replay: swap to secondBest, then play to end normally.
function replayWithSwap(world, logEntry) {
  const state = structuredClone(logEntry.stateBefore);
  // Apply the swap action.
  const idx = logEntry.secondBest;
  if (state.cells[idx].state !== "hidden") return null; // shouldn't happen
  const v = world[idx];
  let flashed = false;
  for (const n of NEIGHBORS[idx]) if (world[n] === "5") { flashed = true; break; }
  recordReveal(state, idx, v, flashed);
  return playToEnd(state, world);
}

function main() {
  const N = Number(process.argv[2] ?? 500);
  const seed = Number(process.argv[3] ?? 0xCAFE);
  const rng = mulberry32(seed);

  const perHand = new Map(); // hand -> { count, sumRegret, flips, swapHelps, swapHurts }
  const bumpHand = (hand) => {
    if (!perHand.has(hand)) perHand.set(hand, { count: 0, sumRegret: 0, flips: 0, swapHelps: 0, swapHurts: 0 });
    return perHand.get(hand);
  };

  const t0 = Date.now();
  let totalGames = 0;
  let baselineGold = 0;
  for (let g = 0; g < N; g++) {
    const world = randomBoard(rng);
    const { score: baseline, moveLog } = playWithLogging(world);
    if (baseline >= 550) baselineGold += 1;
    for (const entry of moveLog) {
      const swapped = replayWithSwap(world, entry);
      if (swapped == null) continue;
      const regret = baseline - swapped; // positive = best was right
      const stats = bumpHand(entry.hand);
      stats.count += 1;
      stats.sumRegret += regret;
      const baselineGoldHere = baseline >= 550;
      const swappedGoldHere = swapped >= 550;
      if (baselineGoldHere !== swappedGoldHere) stats.flips += 1;
      if (swapped > baseline) stats.swapHelps += 1;
      if (swapped < baseline) stats.swapHurts += 1;
    }
    totalGames += 1;
    if ((g + 1) % 25 === 0) {
      const dt = (Date.now() - t0) / 1000;
      const eta = (dt / (g + 1)) * (N - g - 1);
      process.stdout.write(`\r  games=${g+1}/${N}  ${dt.toFixed(1)}s elapsed  ETA ${eta.toFixed(0)}s    `);
    }
  }
  process.stdout.write(`\r${" ".repeat(70)}\r`);
  const dt = (Date.now() - t0) / 1000;
  console.log(`Done in ${dt.toFixed(1)}s. Played ${totalGames} games. Baseline gold = ${(baselineGold/totalGames*100).toFixed(1)}%.`);
  console.log("");
  console.log(`Per-hand regret of swapping to second-best face-down reveal:`);
  console.log(`  hand   moves     mean_regret(pts)   gold_flips    swap_helped     swap_hurt`);
  const handsOrdered = ["1", "2", "3", "4", "5", "K"];
  for (const h of handsOrdered) {
    if (!perHand.has(h)) continue;
    const s = perHand.get(h);
    const meanReg = s.sumRegret / s.count;
    const flipPct = s.flips / s.count * 100;
    const helpPct = s.swapHelps / s.count * 100;
    const hurtPct = s.swapHurts / s.count * 100;
    console.log(`   ${h}    ${String(s.count).padStart(5)}    ${meanReg >= 0 ? "+" : ""}${meanReg.toFixed(2).padStart(7)}            ${flipPct.toFixed(1).padStart(4)}%        ${helpPct.toFixed(1).padStart(4)}%         ${hurtPct.toFixed(1).padStart(4)}%`);
  }
  // Summary
  let totalFlips = 0, totalMoves = 0, totalHelp = 0, totalHurt = 0;
  for (const s of perHand.values()) {
    totalFlips += s.flips;
    totalMoves += s.count;
    totalHelp += s.swapHelps;
    totalHurt += s.swapHurts;
  }
  console.log("");
  console.log(`Across ${totalMoves} hidden-reveal moves:`);
  console.log(`  ${totalFlips} swaps would have flipped gold↔not-gold (${(totalFlips/totalMoves*100).toFixed(2)}%)`);
  console.log(`  ${totalHelp} swaps strictly improved score (${(totalHelp/totalMoves*100).toFixed(2)}%)`);
  console.log(`  ${totalHurt} swaps strictly worsened score (${(totalHurt/totalMoves*100).toFixed(2)}%)`);
}

main();
