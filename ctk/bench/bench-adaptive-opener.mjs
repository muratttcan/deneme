// Test branching variants of the [1,3,16,18] opener. Each strategy is a
// state-aware function that returns the next forced cell or null
// (meaning: hand off to the heuristic). Paired self-play across the
// same board set.
//
// Usage: node ctk/bench-adaptive-opener.mjs [games] [seed]

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

// Play one game where `pickOpenerCell(state, openHistory) -> idx | null`
// is called whenever `disableOpener` is true on the suggestMove side. If
// it returns null, fall back to the heuristic. The strategy decides
// when the opener is "done" by returning null.
function playOne(world, pickOpenerCell) {
  const state = createState();
  const openHistory = []; // [{idx, value, flashed}]
  let safety = 200;
  while (!isGameOver(state) && safety-- > 0) {
    let idx = null;
    if (currentCard(state) === "1") {
      idx = pickOpenerCell(state, openHistory);
    }
    if (idx == null) {
      const s = suggestMove(state, undefined, { disableOpener: true });
      if (!s || s.cellIdx == null) break;
      idx = s.cellIdx;
      const cell = state.cells[idx];
      if (cell.state === "hidden") {
        const flashed = flashedFor(idx, world);
        recordReveal(state, idx, world[idx], flashed);
      } else {
        if (!catchCell(state, idx)) break;
      }
      continue;
    }
    if (state.cells[idx].state !== "hidden") {
      // Already revealed (manual or earlier strategy step), let heuristic pick.
      continue;
    }
    const flashed = flashedFor(idx, world);
    const value = world[idx];
    recordReveal(state, idx, value, flashed);
    openHistory.push({ idx, value, flashed });
  }
  return state.score;
}

// Strategy: fixed [1,3,16,18] (matches current shipped behaviour).
function fixedOpener(state, history) {
  const seq = [1, 3, 16, 18];
  for (const c of seq) if (state.cells[c].state === "hidden") return c;
  return null;
}

// Strategy: after flip 1, if no flash, hand off to heuristic; else continue.
function branchOnFlashFlip1(state, history) {
  const seq = [1, 3, 16, 18];
  if (history.length === 1 && !history[0].flashed) return null;
  for (const c of seq) if (state.cells[c].state === "hidden") return c;
  return null;
}

// Strategy: after each flip, if last flip didn't flash, hand off to heuristic.
function branchOnFlashEachFlip(state, history) {
  const seq = [1, 3, 16, 18];
  if (history.length > 0 && !history[history.length - 1].flashed) return null;
  for (const c of seq) if (state.cells[c].state === "hidden") return c;
  return null;
}

// Strategy: if K already revealed, abort opener.
function abortOnK(state, history) {
  const seq = [1, 3, 16, 18];
  if (history.some((h) => h.value === "K")) return null;
  for (const c of seq) if (state.cells[c].state === "hidden") return c;
  return null;
}

// Strategy: combination — abort on K, AND switch to heuristic when last flip had no flash.
function combo(state, history) {
  if (history.some((h) => h.value === "K")) return null;
  const seq = [1, 3, 16, 18];
  if (history.length > 0 && !history[history.length - 1].flashed) return null;
  for (const c of seq) if (state.cells[c].state === "hidden") return c;
  return null;
}

// Strategy: try alternative dominating set [6, 8, 16, 18] (centre-ish vs corners).
function altSet(state, history) {
  const seq = [6, 8, 16, 18];
  for (const c of seq) if (state.cells[c].state === "hidden") return c;
  return null;
}

// Strategy: alternative dominating set [2, 10, 14, 22] (cross pattern).
function altSet2(state, history) {
  const seq = [2, 10, 14, 22];
  for (const c of seq) if (state.cells[c].state === "hidden") return c;
  return null;
}

function evaluateStrategy(strategy, boards) {
  let gold = 0, silver = 0, sum = 0;
  for (const b of boards) {
    const s = playOne(b, strategy);
    if (s >= 550) gold += 1;
    if (s >= 400) silver += 1;
    sum += s;
  }
  const n = boards.length;
  return { pGold: gold / n, pSilver: silver / n, mean: sum / n, n };
}

function main() {
  const N = Number(process.argv[2] ?? 8000);
  const seed = Number(process.argv[3] ?? 0xADD1);
  const boards = generateBoards(N, seed);
  const strategies = [
    ["fixed [1,3,16,18]", fixedOpener],
    ["branch-flash @ flip1", branchOnFlashFlip1],
    ["branch-flash @ each", branchOnFlashEachFlip],
    ["abort on K", abortOnK],
    ["combo (K + flash)", combo],
    ["alt set [6,8,16,18]", altSet],
    ["alt set [2,10,14,22]", altSet2],
  ];
  console.log(`Adaptive opener test — paired self-play, n=${N}`);
  console.log("");
  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < strategies.length; i++) {
    const [name, fn] = strategies[i];
    const r = evaluateStrategy(fn, boards);
    results.push({ name, ...r });
    const dt = (Date.now() - t0) / 1000;
    const eta = (dt / (i + 1)) * (strategies.length - i - 1);
    process.stdout.write(`\r  ${i+1}/${strategies.length}  ${dt.toFixed(1)}s  ETA ${eta.toFixed(0)}s   `);
  }
  process.stdout.write(`\r${" ".repeat(60)}\r`);
  const baseline = results[0];
  for (const r of results) {
    const se = Math.sqrt(r.pGold * (1 - r.pGold) / r.n) * 100;
    const delta = (r.pGold - baseline.pGold) * 100;
    const tag = r === baseline ? " [baseline]" : "";
    console.log(
      `  ${r.name.padEnd(24)}  pGold=${(r.pGold*100).toFixed(2)}% ±${se.toFixed(2)}  pSilver=${(r.pSilver*100).toFixed(2)}%  mean=${r.mean.toFixed(0)}  Δ=${delta>=0?"+":""}${delta.toFixed(2)}pp${tag}`,
    );
  }
}
main();
