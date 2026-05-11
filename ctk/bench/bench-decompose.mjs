// Score-component decomposition: where do the points the solver doesn't
// score actually go? Per game we track outcome of each board cell so we
// can build a leaderboard of leaks (K-miss, 5-turn yield, bingos, dead
// reveals, never-revealed cells).
//
// Usage: node bench-decompose.mjs [games] [seed]

import {
  createState,
  recordReveal,
  catchCell,
  isGameOver,
  pointsFor,
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

function playOne(world) {
  const state = createState();
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    const s = suggestMove(state);
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
  // Decompose final state into leak buckets.
  const buckets = {
    score: state.score,
    bingos: state.completedBingos.size,
    bingoPoints: state.completedBingos.size * 10,
    kCaptured: false,
    kRevealedUnscored: false,
    kHidden: false,
    nFivesCaught: 0,
    nFivesRevealedUnscored: 0,
    nFivesHidden: 0,
    revealedUnscoredCount: 0,
    revealedUnscoredPoints: 0,
    hiddenCount: 0,
    hiddenPoints: 0,
    perValueRevealedUnscored: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, K: 0 },
    fourPermUnsafe: 0,   // revealed-unscored 4 with revealed-5 neighbour (permanently lost)
    fourTentUnsafe: 0,   // revealed-unscored 4 with no revealed-5 neighbour (could've been safe)
  };
  for (let i = 0; i < state.cells.length; i++) {
    const c = state.cells[i];
    const trueValue = world[i];
    if (c.state === "revealed") {
      if (c.scored) {
        if (trueValue === "K") buckets.kCaptured = true;
        if (trueValue === "5") buckets.nFivesCaught += 1;
      } else {
        buckets.revealedUnscoredCount += 1;
        buckets.revealedUnscoredPoints += pointsFor(c.value);
        buckets.perValueRevealedUnscored[c.value] += 1;
        if (c.value === "K") buckets.kRevealedUnscored = true;
        if (c.value === "5") buckets.nFivesRevealedUnscored += 1;
        if (c.value === "4") {
          let neighborRevealed5 = false;
          for (const n of NEIGHBORS[i]) {
            const nc = state.cells[n];
            if (nc.state === "revealed" && nc.value === "5") { neighborRevealed5 = true; break; }
          }
          if (neighborRevealed5) buckets.fourPermUnsafe += 1;
          else buckets.fourTentUnsafe += 1;
        }
      }
    } else {
      buckets.hiddenCount += 1;
      buckets.hiddenPoints += pointsFor(trueValue);
      if (trueValue === "K") buckets.kHidden = true;
      if (trueValue === "5") buckets.nFivesHidden += 1;
    }
  }
  return buckets;
}

function main() {
  const N = Number(process.argv[2] ?? 5000);
  const seed = Number(process.argv[3] ?? 0xDECAF);
  const rng = mulberry32(seed);
  const t0 = Date.now();

  const accum = {
    n: 0,
    score: 0,
    gold: 0,
    silver: 0,
    bingos: 0,
    kCaptured: 0, kRevealedUnscored: 0, kHidden: 0,
    fivesCaught: 0, fivesRevealedUnscored: 0, fivesHidden: 0,
    revealedUnscoredCount: 0, revealedUnscoredPoints: 0,
    hiddenCount: 0, hiddenPoints: 0,
    perValueRU: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, K: 0 },
    fourPermUnsafe: 0,
    fourTentUnsafe: 0,
  };

  for (let g = 0; g < N; g++) {
    const b = playOne(randomBoard(rng));
    accum.n += 1;
    accum.score += b.score;
    if (b.score >= 550) accum.gold += 1;
    if (b.score >= 400) accum.silver += 1;
    accum.bingos += b.bingos;
    if (b.kCaptured) accum.kCaptured += 1;
    if (b.kRevealedUnscored) accum.kRevealedUnscored += 1;
    if (b.kHidden) accum.kHidden += 1;
    accum.fivesCaught += b.nFivesCaught;
    accum.fivesRevealedUnscored += b.nFivesRevealedUnscored;
    accum.fivesHidden += b.nFivesHidden;
    accum.revealedUnscoredCount += b.revealedUnscoredCount;
    accum.revealedUnscoredPoints += b.revealedUnscoredPoints;
    accum.hiddenCount += b.hiddenCount;
    accum.hiddenPoints += b.hiddenPoints;
    for (const v of [1, 2, 3, 4, 5, "K"]) accum.perValueRU[v] += b.perValueRevealedUnscored[v];
    accum.fourPermUnsafe += b.fourPermUnsafe;
    accum.fourTentUnsafe += b.fourTentUnsafe;
    if ((g + 1) % 100 === 0) {
      const dt = (Date.now() - t0) / 1000;
      const eta = (dt / (g + 1)) * (N - g - 1);
      process.stdout.write(`\r  ${g+1}/${N}  ${dt.toFixed(1)}s  ETA ${eta.toFixed(0)}s   `);
    }
  }
  process.stdout.write(`\r${" ".repeat(60)}\r`);
  const dt = (Date.now() - t0) / 1000;
  const n = accum.n;
  const avg = (x) => (x / n).toFixed(2);
  const pct = (x) => ((x / n) * 100).toFixed(1) + "%";
  console.log(`Decomposed ${n} games in ${dt.toFixed(1)}s.`);
  console.log("");
  console.log(`OUTCOME`);
  console.log(`  mean score          ${avg(accum.score)}`);
  console.log(`  gold rate (≥550)    ${pct(accum.gold)}`);
  console.log(`  silver rate (≥400)  ${pct(accum.silver)}`);
  console.log("");
  console.log(`KING — 100 pts at stake per game`);
  console.log(`  K captured          ${pct(accum.kCaptured)}   = ${avg(accum.kCaptured * 100)} pts/game`);
  console.log(`  K rev'd-unscored    ${pct(accum.kRevealedUnscored)}   (worst case: K-turn missed it)`);
  console.log(`  K hidden at end     ${pct(accum.kHidden)}`);
  console.log(`  K leak              ${avg(100 - accum.kCaptured * 100)} pts/game`);
  console.log("");
  console.log(`FIVES — 3 fives × 50 = 150 pts max per game`);
  console.log(`  5s caught (avg)     ${avg(accum.fivesCaught)} of 3   = ${avg(accum.fivesCaught * 50)} pts/game`);
  console.log(`  5s rev'd-unscored   ${avg(accum.fivesRevealedUnscored)} of 3   (caught events / unsafe reveals)`);
  console.log(`  5s never revealed   ${avg(accum.fivesHidden)} of 3`);
  console.log(`  5 leak              ${avg((3 - accum.fivesCaught / n) * 50 * n)} pts/game`);
  console.log("");
  console.log(`BINGOS — 12 lines × 10 = 120 pts max per game`);
  console.log(`  bingos completed    ${avg(accum.bingos)} of 12   = ${avg(accum.bingos * 10)} pts/game`);
  console.log(`  bingo leak          ${avg((12 - accum.bingos / n) * 10 * n)} pts/game (vs unattainable max)`);
  console.log("");
  console.log(`UNSCORED CELLS — points walked away from`);
  console.log(`  revealed-unscored   ${avg(accum.revealedUnscoredCount)} cells/game = ${avg(accum.revealedUnscoredPoints)} pts/game`);
  console.log(`    by value: 1=${avg(accum.perValueRU[1])}  2=${avg(accum.perValueRU[2])}  3=${avg(accum.perValueRU[3])}  4=${avg(accum.perValueRU[4])}  5=${avg(accum.perValueRU[5])}  K=${avg(accum.perValueRU.K)}
    of which 4s:  permanently-unsafe (next to revealed-5) = ${avg(accum.fourPermUnsafe)} = ${avg(accum.fourPermUnsafe * 40)} pts/game (lost luck)
                  tentatively-unsafe (next to hidden poss-5) = ${avg(accum.fourTentUnsafe)} = ${avg(accum.fourTentUnsafe * 40)} pts/game (potentially recoverable)`);
  console.log(`  hidden at end       ${avg(accum.hiddenCount)} cells/game = ${avg(accum.hiddenPoints)} pts/game`);
  console.log("");
  console.log(`SANITY: mean score ≈ scored cells = unique-cell-points - revealed-unscored - hidden`);
  const totalCellPoints = 7*10 + 4*20 + 5*30 + 5*40 + 3*50 + 100; // = 70+80+150+200+150+100 = 750
  console.log(`  per-game upper bound (every cell scored): ${totalCellPoints} + bingos`);
  console.log(`  expected mean score = ${totalCellPoints} + ${avg(accum.bingos * 10)} - ${avg(accum.revealedUnscoredPoints)} - ${avg(accum.hiddenPoints)} = ${(totalCellPoints + accum.bingos * 10 / n - accum.revealedUnscoredPoints / n - accum.hiddenPoints / n).toFixed(2)}`);
}
main();
