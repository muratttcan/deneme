// Pure state model for Catch the King. No DOM here.
//
// Board: 5x5 = 25 hidden cards. Composition: 7x1, 4x2, 5x3, 5x4, 3x5, 1xK.
// Hand: 12 cards played ascending (5x1, 2x2, 2x3, 1x4, 1x5, 1xK).
// Cards "flash" whenever a flipped cell has a face-down 5 as an 8-neighbor.
// A hand-5 flip with a flash catches the card (0 points, turn ends).

export const GRID_SIZE = 5;
export const CELL_COUNT = GRID_SIZE * GRID_SIZE;

export const BOARD_COUNTS = { 1: 7, 2: 4, 3: 5, 4: 5, 5: 3, K: 1 };

export const HAND_SEQUENCE = ["1", "1", "1", "1", "1", "2", "2", "3", "3", "4", "5", "K"];

export const VALUES = ["1", "2", "3", "4", "5", "K"];

export function pointsFor(value) {
  return value === "K" ? 100 : +value * 10;
}

function numericValue(value) {
  return value === "K" ? 6 : +value;
}

// Precompute 8-neighbor indices for each cell.
export const NEIGHBORS = (() => {
  const out = [];
  for (let idx = 0; idx < CELL_COUNT; idx++) {
    const r = Math.floor(idx / GRID_SIZE);
    const c = idx % GRID_SIZE;
    const ns = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= GRID_SIZE || nc < 0 || nc >= GRID_SIZE) continue;
        ns.push(nr * GRID_SIZE + nc);
      }
    }
    out.push(ns);
  }
  return out;
})();

// 12 bingo lines: 5 rows, 5 cols, 2 diagonals.
export const BINGO_LINES = (() => {
  const lines = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    const row = [];
    for (let c = 0; c < GRID_SIZE; c++) row.push(r * GRID_SIZE + c);
    lines.push(row);
  }
  for (let c = 0; c < GRID_SIZE; c++) {
    const col = [];
    for (let r = 0; r < GRID_SIZE; r++) col.push(r * GRID_SIZE + c);
    lines.push(col);
  }
  const diag1 = [], diag2 = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    diag1.push(i * GRID_SIZE + i);
    diag2.push(i * GRID_SIZE + (GRID_SIZE - 1 - i));
  }
  lines.push(diag1, diag2);
  return lines;
})();

export function createState() {
  const cells = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    cells.push({
      state: "hidden",       // "hidden" | "revealed"
      value: null,            // "1".."5" | "K" when revealed
      flashed: false,         // flash observed when this cell was revealed
      scored: false,          // has the player collected this cell's points?
    });
  }
  return {
    cells,
    remaining: { ...BOARD_COUNTS },
    handIndex: 0,             // into HAND_SEQUENCE
    score: 0,
    completedBingos: new Set(), // set of bingo line indices already awarded
    history: [],              // stack of events for undo
  };
}

export function currentCard(state) {
  if (state.handIndex >= HAND_SEQUENCE.length) return null;
  return HAND_SEQUENCE[state.handIndex];
}

export function isGameOver(state) {
  return currentCard(state) === null;
}

// Hidden cell indices.
export function hiddenCells(state) {
  const out = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (state.cells[i].state === "hidden") out.push(i);
  }
  return out;
}

// Was this cell revealed under a flash event?
function flashNeighbors(state, idx) {
  return NEIGHBORS[idx].filter((n) => state.cells[n].state === "hidden");
}

// Derive per-cell flags.
// - mustNotBe5: a hidden cell is flagged iff a revealed no-flash cell has it as
//   a neighbor (no-flash means zero adjacent 5s, revealed or hidden).
// - constraints: each flashed revealed cell contributes "≥1 of my still-hidden
//   non-mustNotBe5 neighbors is a 5" — but ONLY if no already-revealed neighbor
//   is itself a 5. A revealed-5 neighbor already explains the flash and leaves
//   the face-down neighbors unconstrained.
export function deriveConstraints(state) {
  const mustNotBe5 = new Set();
  const rawConstraints = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const cell = state.cells[i];
    if (cell.state !== "revealed") continue;
    if (cell.flashed) {
      const explainedByRevealedFive = NEIGHBORS[i].some((n) => {
        const nc = state.cells[n];
        return nc.state === "revealed" && nc.value === "5";
      });
      if (explainedByRevealedFive) continue;
      rawConstraints.push(NEIGHBORS[i].filter((n) => state.cells[n].state === "hidden"));
    } else {
      for (const n of NEIGHBORS[i]) {
        if (state.cells[n].state === "hidden") mustNotBe5.add(n);
      }
    }
  }
  // Remove mustNotBe5 cells from each flash constraint.
  const constraints = rawConstraints
    .map((set) => set.filter((c) => !mustNotBe5.has(c)))
    .filter((set) => set.length > 0);
  return { mustNotBe5, constraints };
}

// Which hidden cells are consistent with being a 5?
export function fiveCandidates(state) {
  const { mustNotBe5 } = deriveConstraints(state);
  return hiddenCells(state).filter((i) => !mustNotBe5.has(i));
}

// Every subset of hidden cells (of size `remaining.5`) that satisfies every
// active flash constraint. Exposed for simulation: the PIMC sampler picks a
// uniform placement from this list then permutes non-5 values over the rest.
export function enumerate5Placements(state) {
  const { mustNotBe5, constraints } = deriveConstraints(state);
  const candidates = hiddenCells(state).filter((i) => !mustNotBe5.has(i));
  return enumerateFivePlacements(candidates, state.remaining[5], constraints);
}

// Endgame detector: every remaining hidden cell has a fully determined
// 5-status (P(5)=0 or 1) AND the King's location is known (already revealed
// or deduced to P(K)=1). Without the K pinned down we're still gambling the
// K-turn, which is the opposite of "free cash" — so suppress the easter egg.
// The per-cell money icon is also gated on safe-for-flip so adjacent-to-5
// cells don't get a misleading mark.
export function isTrivialSweep(state, pFive) {
  if (!pFive) pFive = fiveProbabilities(state);
  const kRevealed = state.remaining.K === 0;
  let kDeduced = false;
  if (!kRevealed) {
    const dist = cellValueDistribution(state);
    for (let i = 0; i < CELL_COUNT; i++) {
      if (state.cells[i].state !== "hidden") continue;
      if ((dist.get(i)?.K ?? 0) >= 0.999) {
        kDeduced = true;
        break;
      }
    }
  }
  if (!kRevealed && !kDeduced) return false;

  let sawHidden = false;
  for (let i = 0; i < CELL_COUNT; i++) {
    const cell = state.cells[i];
    if (cell.state !== "hidden") continue;
    sawHidden = true;
    const p5 = pFive.get(i) ?? 0;
    if (p5 >= 0.999 || p5 < 0.001) continue;
    return false;
  }
  return sawHidden;
}

// True iff flipping `cellIdx` with a 5 in hand carries no catch risk.
// In-game behavior: ANY adjacent 5 catches the 5-card — revealed 5s too, not
// just face-down ones. So a neighbor disqualifies the flip if it's a revealed
// 5, or if it's still hidden with nonzero probability of being a 5.
// A hidden neighbor with P(5) = 0 (whether from an explicit no-flash reveal
// or from constraint enumeration) is treated as a confirmed non-5.
// `mustNotBe5` and `pFive` are optional — they're computed if not provided.
export function isSafeFor5Turn(state, cellIdx, mustNotBe5, pFive) {
  if (!pFive) pFive = fiveProbabilities(state);
  for (const n of NEIGHBORS[cellIdx]) {
    const nc = state.cells[n];
    if (nc.state === "revealed") {
      if (nc.value === "5") return false;
    } else {
      const p = pFive.get(n) ?? 0;
      if (p > 0.001) return false;
    }
  }
  return true;
}

// Does placing 5s at `set` (a subset of candidates) satisfy every
// flash-constraint (each constraint shares at least one cell with the set)?
function satisfiesConstraints(set, constraints) {
  const chosen = new Set(set);
  for (const cons of constraints) {
    let hit = false;
    for (const c of cons) if (chosen.has(c)) { hit = true; break; }
    if (!hit) return false;
  }
  return true;
}

// Enumerate all subsets of `candidates` of exactly `k` cells that satisfy all
// constraints. Returns those subsets as arrays of indices.
function enumerateFivePlacements(candidates, k, constraints) {
  const result = [];
  const n = candidates.length;
  if (k < 0 || k > n) return result;
  const current = [];
  function recurse(start, remaining) {
    if (remaining === 0) {
      if (satisfiesConstraints(current, constraints)) {
        result.push(current.slice());
      }
      return;
    }
    const needed = remaining;
    const left = n - start;
    if (left < needed) return;
    for (let i = start; i <= n - needed; i++) {
      current.push(candidates[i]);
      recurse(i + 1, remaining - 1);
      current.pop();
    }
  }
  recurse(0, k);
  return result;
}

// Exact marginal P(cell = 5) for each hidden cell, given constraints.
// Returns Map<cellIdx, probability>.
export function fiveProbabilities(state) {
  const { mustNotBe5, constraints } = deriveConstraints(state);
  const hidden = hiddenCells(state);
  const candidates = hidden.filter((i) => !mustNotBe5.has(i));
  const probs = new Map();
  for (const i of hidden) probs.set(i, 0);

  const remainingFives = state.remaining[5];
  if (remainingFives === 0 || candidates.length === 0) return probs;

  // Size guard. C(25, 3) = 2300, grows quickly only if remaining grows; here
  // max remaining fives is 3, so the search space stays tiny.
  const placements = enumerateFivePlacements(candidates, remainingFives, constraints);
  if (placements.length === 0) {
    // Constraints are infeasible. Fall back to uniform over candidates so the
    // UI doesn't go blank, but this usually means the user input is wrong.
    const p = remainingFives / candidates.length;
    for (const c of candidates) probs.set(c, Math.min(1, p));
    return probs;
  }

  const counts = new Map();
  for (const c of candidates) counts.set(c, 0);
  for (const placement of placements) {
    for (const c of placement) counts.set(c, counts.get(c) + 1);
  }
  const total = placements.length;
  for (const c of candidates) probs.set(c, counts.get(c) / total);
  return probs;
}

// Full per-cell value distribution for every hidden cell.
// Uses exact P(5|c) from enumeration and distributes the non-5 mass among
// remaining non-5 values proportionally to their board counts.
export function cellValueDistribution(state) {
  const pFive = fiveProbabilities(state);
  const hidden = hiddenCells(state);
  const hiddenCount = hidden.length;
  const remaining5 = state.remaining[5];
  const nonFiveSlots = hiddenCount - remaining5;
  const nonFiveRemaining = {
    1: state.remaining[1],
    2: state.remaining[2],
    3: state.remaining[3],
    4: state.remaining[4],
    K: state.remaining.K,
  };

  const dist = new Map();
  for (const i of hidden) {
    const p5 = pFive.get(i) ?? 0;
    const row = { 1: 0, 2: 0, 3: 0, 4: 0, 5: p5, K: 0 };
    if (nonFiveSlots > 0) {
      const notFive = 1 - p5;
      for (const v of ["1", "2", "3", "4", "K"]) {
        row[v] = notFive * (nonFiveRemaining[v] / nonFiveSlots);
      }
    }
    dist.set(i, row);
  }
  return dist;
}

// Does a hand-card `hand` capture a revealed `value`? Returns:
//   "score"    - points awarded, turn ends (same value)
//   "chain"    - points awarded, turn continues (hand strictly greater)
//   "lose"     - no points, turn ends (hand strictly less)
export function compareHandVsRevealed(hand, revealed) {
  if (hand === "K") return revealed === "K" ? "score" : "lose";
  if (revealed === "K") return "lose";
  const h = numericValue(hand);
  const v = numericValue(revealed);
  if (v < h) return "chain";
  if (v === h) return "score";
  return "lose";
}

// Apply a reveal event. Returns {gained, events} for UI feedback.
export function recordReveal(state, cellIdx, value, flashed) {
  const cell = state.cells[cellIdx];
  if (cell.state !== "hidden") return { gained: 0, bingos: [] };
  const hand = currentCard(state);
  if (hand == null) return { gained: 0, bingos: [] };

  const snapshot = {
    kind: "reveal",
    cellIdx,
    prevRemainingForValue: state.remaining[value],
    prevScore: state.score,
    prevHandIndex: state.handIndex,
    prevCompletedBingos: new Set(state.completedBingos),
  };

  cell.state = "revealed";
  cell.value = value;
  cell.flashed = !!flashed;
  state.remaining[value] = Math.max(0, state.remaining[value] - 1);

  let gained = 0;
  let turnEnds = false;
  let scored = false;

  if (hand === "5" && flashed) {
    // Caught by a face-down 5 neighbor. No points, turn ends. Cell is revealed
    // but unscored — a later hand card can still claim it via catchCell().
    turnEnds = true;
  } else {
    const cmp = compareHandVsRevealed(hand, value);
    if (cmp === "score") {
      gained += pointsFor(value);
      scored = true;
      turnEnds = true;
    } else if (cmp === "chain") {
      gained += pointsFor(value);
      scored = true;
      turnEnds = false;
    } else {
      // lose — hand was too low. Cell is revealed but unscored.
      turnEnds = true;
    }
  }
  cell.scored = scored;

  // Bingo fires only when every cell in a line is revealed AND scored — an
  // unclaimed reveal (hand too low) shouldn't count. If this event left the
  // cell unscored, it can't complete anything; otherwise check.
  const bingoResult = scored ? checkBingoCompletions(state, cellIdx) : { gained: 0, newBingos: [] };
  gained += bingoResult.gained;

  state.score += gained;
  if (turnEnds) state.handIndex += 1;

  snapshot.gained = gained;
  snapshot.turnEnded = turnEnds;
  state.history.push(snapshot);

  return { gained, bingos: bingoResult.newBingos, turnEnded: turnEnds };
}

// Scan the bingo lines that include `cellIdx` and mark any whose cells are ALL
// revealed-and-scored as complete. Returns the points gained and the newly
// completed line indices.
function checkBingoCompletions(state, cellIdx) {
  let gained = 0;
  const newBingos = [];
  for (let lineIdx = 0; lineIdx < BINGO_LINES.length; lineIdx++) {
    if (state.completedBingos.has(lineIdx)) continue;
    const line = BINGO_LINES[lineIdx];
    if (!line.includes(cellIdx)) continue;
    const complete = line.every((i) => {
      const c = state.cells[i];
      return c.state === "revealed" && c.scored;
    });
    if (complete) {
      state.completedBingos.add(lineIdx);
      newBingos.push(lineIdx);
      gained += 10;
    }
  }
  return { gained, newBingos };
}

// Claim points for a revealed-but-unscored cell with the current hand card.
// Mirrors the scoring rules for a fresh reveal: value < hand chains, value ==
// hand ends the turn. Values > hand return null (can't be claimed with this
// hand). Revealed-5 cells captured during the 5-turn reveal (hand=5 + flash)
// stay unscored and can still be claimed later for +50.
export function catchCell(state, cellIdx) {
  const cell = state.cells[cellIdx];
  if (cell.state !== "revealed" || cell.scored) return null;
  const hand = currentCard(state);
  if (!hand) return null;
  const cmp = compareHandVsRevealed(hand, cell.value);
  if (cmp === "lose") return null;
  // On the 5-turn, claiming any cell with a 5 adjacent (revealed OR deduced
  // face-down) would trigger the catch mechanic and score 0. Refuse rather
  // than pretend it scored.
  if (hand === "5" && !isSafeFor5Turn(state, cellIdx)) return null;

  const snapshot = {
    kind: "catch",
    cellIdx,
    prevScore: state.score,
    prevHandIndex: state.handIndex,
    prevCompletedBingos: new Set(state.completedBingos),
  };

  cell.scored = true;
  let gained = pointsFor(cell.value);
  // Catching can complete a bingo if this was the last unscored cell in a line.
  const bingoResult = checkBingoCompletions(state, cellIdx);
  gained += bingoResult.gained;
  state.score += gained;
  const turnEnded = cmp === "score";
  if (turnEnded) state.handIndex += 1;

  snapshot.gained = gained;
  snapshot.turnEnded = turnEnded;
  state.history.push(snapshot);

  return { gained, turnEnded, bingos: bingoResult.newBingos };
}

export function undo(state) {
  const last = state.history.pop();
  if (!last) return false;
  if (last.kind === "catch") {
    const cell = state.cells[last.cellIdx];
    cell.scored = false;
    state.score = last.prevScore;
    state.handIndex = last.prevHandIndex;
    if (last.prevCompletedBingos) state.completedBingos = last.prevCompletedBingos;
    return true;
  }
  if (last.kind !== "reveal") return false;
  const cell = state.cells[last.cellIdx];
  state.remaining[cell.value] = last.prevRemainingForValue;
  cell.state = "hidden";
  cell.value = null;
  cell.flashed = false;
  cell.scored = false;
  state.score = last.prevScore;
  state.handIndex = last.prevHandIndex;
  state.completedBingos = last.prevCompletedBingos;
  return true;
}

export function reset() {
  return createState();
}

// Optimistic upper bound on how many more points the game could still yield
// from the current state. Counts every unscored revealed cell whose value is
// catchable by some remaining hand card, every still-face-down card's value
// (assuming we can reveal and catch it), plus a +10 for each bingo line that
// hasn't fired yet. Intended as a ceiling, not an expectation — useful for
// understanding whether the 550 target is even reachable.
export function maxPossibleRemaining(state) {
  const remainingHands = HAND_SEQUENCE.slice(state.handIndex);
  const canCatchValue = (v) =>
    remainingHands.some((h) => {
      const cmp = compareHandVsRevealed(h, v);
      return cmp === "score" || cmp === "chain";
    });

  let max = 0;
  for (const cell of state.cells) {
    if (cell.state === "revealed" && !cell.scored && canCatchValue(cell.value)) {
      max += pointsFor(cell.value);
    }
  }
  for (const v of VALUES) {
    if (canCatchValue(v)) max += state.remaining[v] * pointsFor(v);
  }
  max += (BINGO_LINES.length - state.completedBingos.size) * 10;
  return max;
}
