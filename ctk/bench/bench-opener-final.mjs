// Final tight comparison of opener candidates at n=15k paired.

import {
  createState, recordReveal, catchCell, isGameOver,
  currentCard, NEIGHBORS, BOARD_COUNTS,
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
    if (state.cells[idx].state === "hidden") recordReveal(state, idx, world[idx], flashedFor(idx, world));
    else if (!catchCell(state, idx)) break;
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
  const N = Number(process.argv[2] ?? 15000);
  const seed = Number(process.argv[3] ?? 0xCAFE);
  const boards = generateBoards(N, seed);
  const candidates = [
    { name: "shipped [1,3,16,18]", set: [1, 3, 16, 18] },
    { name: "[6,8,16,18]", set: [6, 8, 16, 18] },
    { name: "[6,8,16,19]", set: [6, 8, 16, 19] },
    { name: "[6,8,18,21]", set: [6, 8, 18, 21] },
    { name: "[6,8,19,21]", set: [6, 8, 19, 21] },
  ];
  console.log(`Final opener comparison — n=${N}, seed=0x${seed.toString(16)}`);
  console.log("");
  const t0 = Date.now();
  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const r = evaluate(c.set, boards);
    out.push({ ...c, ...r });
    const dt = (Date.now() - t0) / 1000;
    const eta = (dt / (i + 1)) * (candidates.length - i - 1);
    process.stdout.write(`\r  ${i+1}/${candidates.length}  ${dt.toFixed(0)}s  ETA ${eta.toFixed(0)}s   `);
  }
  process.stdout.write(`\r${" ".repeat(70)}\r`);
  out.sort((a, b) => b.pGold - a.pGold);
  const baseline = out.find((r) => r.set[0] === 1).pGold;
  for (const r of out) {
    const se = Math.sqrt(r.pGold * (1 - r.pGold) / N) * 100;
    const delta = (r.pGold - baseline) * 100;
    console.log(`  ${r.name.padEnd(22)}  pGold=${(r.pGold*100).toFixed(2)}% ±${se.toFixed(2)}  mean=${r.mean.toFixed(0)}  Δ=${delta>=0?"+":""}${delta.toFixed(2)}pp`);
  }
}
main();
