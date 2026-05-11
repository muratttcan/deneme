// Cohort diagnostics. For each game records: K-reveal timing, 5-turn outcome,
// bingos, unscored revealed cells at end, final score. Splits results by tier
// (gold/silver/bronze/sub) and reports per-cohort averages so we can SEE what
// differs between gold finishes and sub-gold finishes — i.e. where the solver
// is leaving points on the table.
//
// Usage:  node diagnose.mjs [games]
// Default: 10000.

import {
  createState,
  recordReveal,
  catchCell,
  isGameOver,
  NEIGHBORS,
  CELL_COUNT,
  BOARD_COUNTS,
  HAND_SEQUENCE,
  pointsFor,
} from "../game.js";
import { suggestMove } from "../solver.js";

const FIVE_HAND_INDEX = HAND_SEQUENCE.indexOf("5"); // 10
const K_HAND_INDEX = HAND_SEQUENCE.indexOf("K");    // 11

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

function randomBoard() {
  const v = [];
  for (const k of Object.keys(BOARD_COUNTS)) for (let i = 0; i < BOARD_COUNTS[k]; i++) v.push(k);
  shuffleInPlace(v);
  return v;
}

function flashedFor(idx, world) {
  for (const n of NEIGHBORS[idx]) if (world[n] === "5") return true;
  return false;
}

function playGameWithDiag(world) {
  const state = createState();
  const kIdx = world.indexOf("K");

  const diag = {
    score: 0,
    kRevealedEarly: false,        // K flipped before the K-turn began
    kRevealHandIndex: -1,         // hand index when K was first revealed (-1 if never)
    fiveTurnEntered: false,
    fiveTurnGained: 0,            // points scored during the entire 5-turn
    fiveTurnCaught: false,        // 5-turn ended at 0 pts (catch mechanic fired)
    bingos: 0,
    unscoredCells: 0,             // revealed-but-unscored at game end
    unscoredValueSum: 0,          // points worth of unscored cells left behind
  };

  let scoreBeforeFive = -1;
  let safety = 200;

  while (!isGameOver(state) && safety-- > 0) {
    const prevHand = state.handIndex;
    if (prevHand === FIVE_HAND_INDEX && !diag.fiveTurnEntered) {
      diag.fiveTurnEntered = true;
      scoreBeforeFive = state.score;
    }

    const sug = suggestMove(state);
    if (!sug || sug.cellIdx == null) break;

    const idx = sug.cellIdx;
    const cell = state.cells[idx];
    if (cell.state === "hidden") {
      recordReveal(state, idx, world[idx], flashedFor(idx, world));
      if (idx === kIdx && diag.kRevealHandIndex < 0) {
        diag.kRevealHandIndex = prevHand;
        if (prevHand < K_HAND_INDEX) diag.kRevealedEarly = true;
      }
    } else {
      if (!catchCell(state, idx)) break;
    }

    if (prevHand === FIVE_HAND_INDEX && state.handIndex !== FIVE_HAND_INDEX) {
      diag.fiveTurnGained = state.score - scoreBeforeFive;
      diag.fiveTurnCaught = diag.fiveTurnGained === 0;
    }
  }

  diag.bingos = state.completedBingos.size;
  diag.score = state.score;
  for (const cell of state.cells) {
    if (cell.state === "revealed" && !cell.scored) {
      diag.unscoredCells += 1;
      diag.unscoredValueSum += pointsFor(cell.value);
    }
  }
  return diag;
}

function tierFor(score) {
  if (score >= 550) return "gold";
  if (score >= 400) return "silver";
  if (score >= 100) return "bronze";
  return "sub";
}

function summarize(diags) {
  const n = diags.length;
  if (n === 0) return null;
  const avg = (fn) => diags.reduce((a, d) => a + fn(d), 0) / n;
  const fraction = (fn) => diags.filter(fn).length / n;
  const fiveOnly = diags.filter((d) => d.fiveTurnEntered);
  return {
    n,
    avgScore: avg((d) => d.score),
    pctKEarly: fraction((d) => d.kRevealedEarly),
    pctFiveEntered: fraction((d) => d.fiveTurnEntered),
    pctFiveCaught: fiveOnly.length ? fiveOnly.filter((d) => d.fiveTurnCaught).length / fiveOnly.length : 0,
    avgFiveGained: fiveOnly.length ? fiveOnly.reduce((a, d) => a + d.fiveTurnGained, 0) / fiveOnly.length : 0,
    avgBingos: avg((d) => d.bingos),
    avgUnscored: avg((d) => d.unscoredCells),
    avgPtsLeft: avg((d) => d.unscoredValueSum),
  };
}

function pct(x) { return (x * 100).toFixed(1) + "%"; }
function num(x, p = 1) { return x.toFixed(p); }

function main() {
  const n = Number(process.argv[2] ?? 10000);
  console.log(`Diagnostic run: ${n} games with the heuristic solver.`);
  const t0 = Date.now();
  const all = [];
  for (let i = 0; i < n; i++) {
    all.push(playGameWithDiag(randomBoard()));
    if ((i + 1) % 500 === 0) {
      const dt = (Date.now() - t0) / 1000;
      process.stdout.write(`\r  ${i + 1}/${n}  ${dt.toFixed(1)}s     `);
    }
  }
  process.stdout.write(`\r${" ".repeat(60)}\r`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);

  const cohorts = {
    overall: summarize(all),
    gold: summarize(all.filter((d) => tierFor(d.score) === "gold")),
    silver: summarize(all.filter((d) => tierFor(d.score) === "silver")),
    bronze: summarize(all.filter((d) => tierFor(d.score) === "bronze")),
    sub: summarize(all.filter((d) => tierFor(d.score) === "sub")),
  };

  const cols = ["overall", "gold", "silver", "bronze"];
  if (cohorts.sub) cols.push("sub");

  const W_LABEL = 32;
  const W_COL = 12;
  const headerCells = cols.map((c) => {
    const label = `${c[0].toUpperCase()}${c.slice(1)} (${cohorts[c].n})`;
    return label.padStart(W_COL);
  }).join("");
  console.log("Metric".padEnd(W_LABEL) + headerCells);
  console.log("─".repeat(W_LABEL + W_COL * cols.length));

  function row(label, fn) {
    console.log(label.padEnd(W_LABEL) + cols.map((c) => fn(cohorts[c]).padStart(W_COL)).join(""));
  }

  row("Avg final score",        (s) => num(s.avgScore, 1));
  row("K revealed pre-K-turn",  (s) => pct(s.pctKEarly));
  row("Reached 5-turn",         (s) => pct(s.pctFiveEntered));
  row("5-turn caught at 0",     (s) => pct(s.pctFiveCaught));
  row("Avg pts in 5-turn",      (s) => num(s.avgFiveGained, 1));
  row("Avg bingos",             (s) => num(s.avgBingos, 2));
  row("Unscored cells at end",  (s) => num(s.avgUnscored, 2));
  row("Pts left unscored",      (s) => num(s.avgPtsLeft, 1));

  // Highlight the gold-vs-sub-gold deltas — that's where the lever is.
  console.log("");
  console.log("Largest gold-vs-silver gaps:");
  const g = cohorts.gold, s = cohorts.silver;
  const deltas = [
    ["K revealed pre-K-turn",  (g.pctKEarly - s.pctKEarly) * 100, "pp"],
    ["5-turn caught at 0",     (g.pctFiveCaught - s.pctFiveCaught) * 100, "pp"],
    ["Avg pts in 5-turn",      g.avgFiveGained - s.avgFiveGained, "pts"],
    ["Avg bingos",             g.avgBingos - s.avgBingos, "lines"],
    ["Pts left unscored",      g.avgPtsLeft - s.avgPtsLeft, "pts"],
  ].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  for (const [label, delta, unit] of deltas) {
    const sign = delta > 0 ? "+" : "";
    console.log(`  ${label.padEnd(28)} ${sign}${num(delta, 2)} ${unit}`);
  }
}

main();
