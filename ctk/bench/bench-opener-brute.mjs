// Brute-force search over all 4-cell dominating sets of the 5x5 8-grid.
// For each, paired self-play against a fixed board set. Two-stage to
// avoid wasting time on bad candidates: stage 1 small-n filter, stage
// 2 large-n confirmation of the top survivors.
//
// Usage: node ctk/bench-opener-brute.mjs [stage1-n] [stage2-n]

import {
  createState,
  recordReveal,
  catchCell,
  isGameOver,
  currentCard,
  NEIGHBORS,
  CELL_COUNT,
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
function flashedFor(idx, world) {
  for (const n of NEIGHBORS[idx]) if (world[n] === "5") return true;
  return false;
}

function isDominating(set) {
  const covered = new Set(set);
  for (const c of set) for (const n of NEIGHBORS[c]) covered.add(n);
  return covered.size === CELL_COUNT;
}

// Generate all 4-cell dominating sets, deduped (sorted ascending).
function allDominatingSets() {
  const out = [];
  for (let a = 0; a < CELL_COUNT; a++) {
    for (let b = a + 1; b < CELL_COUNT; b++) {
      for (let c = b + 1; c < CELL_COUNT; c++) {
        for (let d = c + 1; d < CELL_COUNT; d++) {
          const s = [a, b, c, d];
          if (isDominating(s)) out.push(s);
        }
      }
    }
  }
  return out;
}

function playOne(world, openingArr) {
  const state = createState();
  let openIdx = 0;
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    while (openIdx < openingArr.length && state.cells[openingArr[openIdx]].state !== "hidden") openIdx++;
    if (currentCard(state) === "1" && openIdx < openingArr.length) {
      const idx = openingArr[openIdx++];
      recordReveal(state, idx, world[idx], flashedFor(idx, world));
      continue;
    }
    const s = suggestMove(state, undefined, { disableOpener: true });
    if (!s || s.cellIdx == null) break;
    const idx = s.cellIdx;
    const cell = state.cells[idx];
    if (cell.state === "hidden") {
      recordReveal(state, idx, world[idx], flashedFor(idx, world));
    } else {
      if (!catchCell(state, idx)) break;
    }
  }
  return state.score;
}

function evaluate(opening, boards) {
  let gold = 0, sum = 0;
  for (const b of boards) {
    const s = playOne(b, opening);
    if (s >= 550) gold += 1;
    sum += s;
  }
  return { pGold: gold / boards.length, mean: sum / boards.length };
}

function main() {
  const N1 = Number(process.argv[2] ?? 800);
  const N2 = Number(process.argv[3] ?? 8000);
  const sets = allDominatingSets();
  console.log(`Found ${sets.length} 4-cell dominating sets of the 5x5 8-grid.`);
  console.log(`Stage 1: ${N1} paired games each. Stage 2: top 12 + baseline at ${N2}.`);
  console.log("");

  const stage1Boards = generateBoards(N1, 0x5EED1);
  const t0 = Date.now();
  const stage1 = sets.map((s, i) => {
    const r = evaluate(s, stage1Boards);
    if ((i + 1) % 5 === 0) {
      const dt = (Date.now() - t0) / 1000;
      const eta = (dt / (i + 1)) * (sets.length - i - 1);
      process.stdout.write(`\r  stage 1: ${i+1}/${sets.length}  ${dt.toFixed(0)}s  ETA ${eta.toFixed(0)}s    `);
    }
    return { set: s, ...r };
  });
  process.stdout.write(`\r${" ".repeat(70)}\r`);
  stage1.sort((a, b) => b.pGold - a.pGold);
  console.log(`Stage 1 complete in ${((Date.now()-t0)/1000).toFixed(0)}s. Top 8:`);
  for (let i = 0; i < Math.min(8, stage1.length); i++) {
    const r = stage1[i];
    console.log(`  ${(i+1).toString().padStart(2)}. [${r.set.join(",")}]  pGold=${(r.pGold*100).toFixed(2)}%  mean=${r.mean.toFixed(0)}`);
  }
  // Always include current shipped opener as anchor.
  const SHIPPED = [1, 3, 16, 18];
  const anchorIdx = stage1.findIndex((r) => r.set.length === 4 && r.set[0] === 1 && r.set[1] === 3 && r.set[2] === 16 && r.set[3] === 18);
  const anchor = anchorIdx >= 0 ? stage1[anchorIdx] : null;
  if (anchor) console.log(`  shipped [1,3,16,18] is rank ${anchorIdx+1} pGold=${(anchor.pGold*100).toFixed(2)}%`);

  // Stage 2.
  console.log("");
  const top = stage1.slice(0, 12);
  if (anchor && !top.includes(anchor)) top.push(anchor);
  const stage2Boards = generateBoards(N2, 0xB14660);
  console.log(`Stage 2: ${top.length} candidates × ${N2} paired games`);
  const t1 = Date.now();
  const stage2 = top.map((r, i) => {
    const s2 = evaluate(r.set, stage2Boards);
    const dt = (Date.now() - t1) / 1000;
    const eta = (dt / (i + 1)) * (top.length - i - 1);
    process.stdout.write(`\r  stage 2: ${i+1}/${top.length}  ${dt.toFixed(0)}s  ETA ${eta.toFixed(0)}s    `);
    return { set: r.set, ...s2 };
  });
  process.stdout.write(`\r${" ".repeat(70)}\r`);
  stage2.sort((a, b) => b.pGold - a.pGold);
  console.log(`Stage 2 complete in ${((Date.now()-t1)/1000).toFixed(0)}s.`);
  console.log("");
  console.log(`Stage 2 results (n=${N2}):`);
  for (const r of stage2) {
    const se = Math.sqrt(r.pGold * (1 - r.pGold) / N2) * 100;
    const tag = r.set[0] === 1 && r.set[1] === 3 && r.set[2] === 16 && r.set[3] === 18 ? " [shipped]" : "";
    console.log(`  [${r.set.join(",").padEnd(13)}]  pGold=${(r.pGold*100).toFixed(2)}% ±${se.toFixed(2)}  mean=${r.mean.toFixed(0)}${tag}`);
  }
}
main();
