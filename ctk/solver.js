// Best-move suggester. Greedy one-step expected value with hand-aware scoring.
//
// Goal: help the player reach at least 550 points. We rank each hidden cell by
// expected points from flipping it with the current hand card, with a heavy
// safety penalty during the 5-turn, and we prefer cells that complete a bingo
// line or continue a scoring chain.

import {
  NEIGHBORS,
  BINGO_LINES,
  VALUES,
  GRID_SIZE,
  HAND_SEQUENCE,
  cellValueDistribution,
  fiveProbabilities,
  enumerate5Placements,
  hiddenCells,
  currentCard,
  pointsFor,
  compareHandVsRevealed,
  deriveConstraints,
  isSafeFor5Turn,
} from "./game.js";
import { t } from "./i18n.js";
import { suggestMoveSearch } from "./search.js";

// Late-game expectimax. Triggers when the state is small enough for the
// search to terminate within budget — past hand=5 with too many hidden cells
// branching explodes. Empirically ≤ 6 hidden cells stays under ~50k nodes
// with useful resolution; expanding to hand=4 was tried but fails because
// budget-exhausted leaves return state.score (no future estimate), so the
// search picks worse moves than the heuristic. The fix would be a heuristic
// leaf evaluator — left for future work.
const SEARCH_TRIGGER_HAND_INDEX = 10;
const SEARCH_MAX_HIDDEN = 6;
// When below the gold target we widen the search ceiling by one cell so
// borderline late-game states (score 350-549 with 7 hidden cells) still
// get gold-aware play instead of falling back to greedy heuristic EV.
// Going higher (8+ hidden) blows up branching cost — empirically ~18×
// per-game time at maxHidden=8 — so we stop at 7 with a modest budget
// bump. If the search exhausts we degrade to the heuristic.
const SEARCH_MAX_HIDDEN_GOLD = 7;
const SEARCH_NODE_BUDGET = 50000;
const SEARCH_NODE_BUDGET_GOLD = 80000;

const SCORE_TARGET = 550;
const FIVE_CARD_INDEX = HAND_SEQUENCE.indexOf("5");

// Hardcoded opening: a dominating-set pattern that covers the whole 5×5 board
// with 4 reveals (every cell either revealed or a neighbour of a revealed
// cell). Beats greedy info-flip by ~+1.7pp gold per tune-opening.mjs. The
// gain comes from a multi-turn property — saving the centre for later — that
// a one-step heuristic can't see.
const OPENING_PATTERN = [6, 8, 16, 18];

// All tunable weights in one place so offline search (tune.mjs) can sweep
// them. suggestMove() accepts an optional weights argument and falls back to
// these defaults, so the in-browser app never notices the refactor.
//
// Current values were produced by tune.mjs: n=3000 paired self-play games
// lifted pGold from 31.6% to 40.1% vs. a hand-tuned starting point.
// Chain-greed (chainBonusMul) and info-seeking (infoWeight) were the biggest
// wins — both came in well below the game's optimum.
// Phase-split weights. Each tunable dimension that genuinely behaves
// differently across the game gets a separate value per phase:
//   - early: hand="1"     (handIndex 0–4)   — info-gathering, no chains
//   - mid:   hand="2"–"4" (handIndex 5–9)   — chains start, mid-game decisions
//   - late:  hand="5"/"K" (handIndex 10–11) — safety + endgame
// Phase-flat weights stay scalar (catchPenalty only fires hand=5; centerTiebreak
// is a weak tiebreaker the tuner found no signal in).
//
// Existing single-config values seeded into all 3 phases as a starting point;
// a fresh tuner sweep can then specialise each phase independently.
export const DEFAULT_WEIGHTS = {
  catchPenalty: 612,                                        // hand=5 only — phase-flat
  centerTiebreak: 0.037,                                    // weak tiebreak — phase-flat
  infoWeight:    { early: 20,   mid: 20,   late: 20 },      // Shannon info gain × multiplier
  chainBonusMul: { early: 1.94, mid: 1.94, late: 1.94 },    // chain-continuation EV × mul
  kHuntBase:     { early: 150,  mid: 150,  late: 150 },     // K-hunt floor
  kHuntSlope:    { early: 2.46, mid: 2.46, late: 2.46 },    // extra weight per pt of gap
  kHuntMax:      { early: 727,  mid: 727,  late: 727 },     // K-hunt ceiling
  spreadWeight:  { early: 0,    mid: 0,    late: 0 },       // board-coverage prior
  bingoProgressWeight: { early: 12, mid: 12, late: 12 },    // partial-line credit (sum of (othersDone/4)^2 over incomplete lines)
};

// Phase derived from the current hand. Recomputed per call (cheap).
function phaseFor(state) {
  const h = state.handIndex;
  if (h <= 4) return "early";
  if (h <= 9) return "mid";
  return "late";
}

// Resolve a phase-keyed weight to a scalar — accepts either the phase-split
// object form or a legacy flat scalar (so tests / external callers passing
// flat objects still work).
function pick(w, key, phase) {
  const v = w[key];
  if (v == null) return 0;
  return typeof v === "object" ? v[phase] : v;
}

// The K-turn's +100 is often the difference between the silver (400) and gold
// (550) chest. When the current score is far below 550, revealing K early —
// which converts the K-turn from a probability-weighted guess into a
// deterministic +100 — is the highest-leverage move available. Scale the
// K-hunt bonus by the score gap so it automatically goes up when we need it.
function kHuntWeight(state, w, phase) {
  const gap = Math.max(0, SCORE_TARGET - state.score);
  const base = pick(w, "kHuntBase", phase);
  const slope = pick(w, "kHuntSlope", phase);
  const max = pick(w, "kHuntMax", phase);
  return Math.min(max, base + gap * slope);
}

// "Informative" neighbors — neighbors whose 5-status the flash signal can
// still distinguish. The flash is predetermined if any adjacent cell is a
// confirmed 5 (revealed OR deduced P(5)=1): it will always fire, giving no
// new information. Otherwise, count hidden neighbors that still have a
// nonzero probability of being a 5 — each contributes to the flash signal's
// uncertainty.
function informativeNeighborCount(state, cellIdx, pFive) {
  for (const n of NEIGHBORS[cellIdx]) {
    const nc = state.cells[n];
    if (nc.state === "revealed" && nc.value === "5") return 0;
    if (nc.state === "hidden" && (pFive.get(n) ?? 0) >= 0.999) return 0;
  }
  let count = 0;
  for (const n of NEIGHBORS[cellIdx]) {
    const nc = state.cells[n];
    if (nc.state === "hidden" && (pFive.get(n) ?? 0) > 0.001) count += 1;
  }
  return count;
}

// Has every hidden cell that could still be a 5 already been "seen" by a
// flash from some revealed neighbour? If yes, the opener has nothing left
// to learn about 5-locations even if not all of its moves were played —
// e.g. when constraint propagation pins all candidates to one side of the
// board after just two reveals. Deduced-certain 5s (P=1) are also covered:
// their flash status is fully determined.
function fivesFullyInformed(state) {
  if (state.remaining[5] === 0) return true;
  const pFive = fiveProbabilities(state);
  for (let i = 0; i < state.cells.length; i++) {
    if (state.cells[i].state !== "hidden") continue;
    const p = pFive.get(i) ?? 0;
    if (p <= 0 || p >= 0.999) continue;
    let seen = false;
    for (const n of NEIGHBORS[i]) {
      if (state.cells[n].state === "revealed") { seen = true; break; }
    }
    if (!seen) return false;
  }
  return true;
}

function centerDistance(cellIdx) {
  const r = Math.floor(cellIdx / GRID_SIZE);
  const c = cellIdx % GRID_SIZE;
  const mid = (GRID_SIZE - 1) / 2;
  return Math.hypot(r - mid, c - mid);
}

// Count of `cellIdx`'s hidden neighbours that aren't already adjacent to some
// other revealed cell. Higher number = flipping this cell pulls more "fresh"
// area into the helper's adjacency view. Encodes a board-coverage prior so
// the heuristic spreads its reveals instead of clustering them.
function spreadCount(state, cellIdx) {
  let count = 0;
  for (const n of NEIGHBORS[cellIdx]) {
    const nc = state.cells[n];
    if (nc.state === "revealed") continue;
    let alreadyAdjacent = false;
    for (const nn of NEIGHBORS[n]) {
      if (nn === cellIdx) continue;
      if (state.cells[nn].state === "revealed") { alreadyAdjacent = true; break; }
    }
    if (!alreadyAdjacent) count += 1;
  }
  return count;
}

// Uncertainty of a cell's value as a ratio in [0, 1]. A must-be-5 or must-be-X
// cell returns 0 (no information to learn). A uniform distribution returns 1.
// Kept as a fallback for edge cases (no enumerated placements available).
function valueUncertainty(dist) {
  const maxH = Math.log2(VALUES.length);
  let h = 0;
  for (const v of VALUES) {
    const p = dist[v] ?? 0;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h / maxH;
}

// Shannon information gain (in bits) about the 5-placement from revealing
// `cellIdx`, computed exactly from the constraint enumeration. Replaces the
// hand-crafted "uncertainty × (1 + flashInfo × w)" proxy.
//
// Outcome partition for a reveal of c:
//   A: c is itself a 5            → posterior = placements containing c
//   B: c is non-5, no flash       → posterior = placements with no neighbour of c being a 5
//   C: c is non-5, with flash     → posterior = placements with c absent but ≥1 neighbour present
// Probabilities = |A|/|P|, |B|/|P|, |C|/|P| (uniform-prior over enumerated worlds).
//   InfoGain = H(prior) − Σ p_outcome × H(posterior_outcome)
function infoGainAboutFives(cellIdx, placements) {
  const total = placements.length;
  if (total <= 1) return 0;
  const neighSet = new Set(NEIGHBORS[cellIdx]);
  let inCell = 0;
  let notInNoFlash = 0;
  let notInFlash = 0;
  for (const p of placements) {
    let cellHas = false;
    let neighHas = false;
    for (const c of p) {
      if (c === cellIdx) cellHas = true;
      else if (neighSet.has(c)) neighHas = true;
    }
    if (cellHas) inCell += 1;
    else if (neighHas) notInFlash += 1;
    else notInNoFlash += 1;
  }
  const log2 = Math.log2;
  const Hprior = log2(total);
  let Hpost = 0;
  if (inCell > 0) Hpost += (inCell / total) * log2(inCell);
  if (notInNoFlash > 0) Hpost += (notInNoFlash / total) * log2(notInNoFlash);
  if (notInFlash > 0) Hpost += (notInFlash / total) * log2(notInFlash);
  return Math.max(0, Hprior - Hpost);
}

function fiveAhead(state) {
  return state.handIndex < FIVE_CARD_INDEX;
}

// Expected points from flipping this cell *with a 5 in hand*, assuming the
// cell is safe (no catch risk). K reveal still ends the turn with 0 points.
function expectedPointsIfFiveTurn(dist) {
  let ev = 0;
  for (const v of VALUES) {
    if (v === "K") continue;
    ev += (dist[v] ?? 0) * pointsFor(v);
  }
  return ev;
}

// Exact P(at least one face-down 8-neighbor of `cellIdx` is a 5), computed
// from the enumerated consistent 5-placements. Replaces the old independence
// approximation — neighbours that compete for the same 5-supply are
// negatively correlated, while flash-constrained neighbours are positively
// correlated, so a marginal-product underestimates one and overestimates the
// other. The exact ratio fixes both.
function probAnyNeighborIsFive(state, cellIdx, placements) {
  // Any already-revealed adjacent 5 guarantees a catch — short-circuit.
  for (const n of NEIGHBORS[cellIdx]) {
    const nc = state.cells[n];
    if (nc.state === "revealed" && nc.value === "5") return 1;
  }
  if (!placements || placements.length === 0) return 0;
  const neighSet = new Set(NEIGHBORS[cellIdx]);
  let hits = 0;
  for (const p of placements) {
    for (const c of p) {
      if (neighSet.has(c)) { hits += 1; break; }
    }
  }
  return hits / placements.length;
}

// Will `cell` ever score given the remaining hand sequence? A revealed-
// unscored cell can score by:
//   - same-value catch: a remaining hand card equals its value (and the cell
//     is safe-for-5 if the value is 5; or unconditionally for K).
//   - chain catch: a remaining hand card is strictly greater. Hand=5 chain
//     additionally requires safe-for-5; hands 2-4 chain unconditionally.
// If neither path remains we declare the cell "permanently dead" — its line
// can never bingo. Bingo bonuses on that line are phantom and we should not
// reward progress toward a line that contains one.
function isCellPermanentlyDead(state, cellIdx) {
  const cell = state.cells[cellIdx];
  if (cell.state !== "revealed" || cell.scored) return false;
  const v = cell.value;
  if (v === "K") {
    // K can be caught by hand=K only. If we're past that, dead.
    return state.handIndex > HAND_SEQUENCE.indexOf("K");
  }
  // Future hand cards (those still ahead).
  const fiveIdx = HAND_SEQUENCE.indexOf("5");
  const fourIdx = HAND_SEQUENCE.indexOf("4");
  const valueFirstIdx = HAND_SEQUENCE.indexOf(v);
  const sameValueAhead = state.handIndex <= valueFirstIdx;
  if (sameValueAhead) return false;          // hand=v will catch it
  if (v === "5") return true;                // past hand=5 same-value, dead
  // Chain catches: 2-4 chain unconditionally; 5 chains 1-4 only when safe.
  if (state.handIndex <= fourIdx) return false; // hand=4 ahead → unconditional chain catches 1-3
  // Past hand=4. Only hand=5 chain remains.
  if (state.handIndex > fiveIdx) return true;   // past hand=5 too: dead
  // At hand=5. v ∈ {1,2,3,4}; chain requires safe-for-5.
  for (const n of NEIGHBORS[cellIdx]) {
    const nc = state.cells[n];
    if (nc.state === "revealed" && nc.value === "5") return true; // permanently unsafe
  }
  return false;
}

function lineHasPermanentlyDeadCell(state, line) {
  for (const c of line) if (isCellPermanentlyDead(state, c)) return true;
  return false;
}

// How many bingo lines would flipping `cellIdx` (and getting it scored)
// complete? Bingo now requires every cell in the line to be revealed AND
// scored, so count only lines where every OTHER cell already satisfies that.
// Lines containing a permanently-unscoreable cell are skipped — they can
// never complete regardless of what we flip.
function bingoLinesCompletedBy(state, cellIdx) {
  let count = 0;
  for (let i = 0; i < BINGO_LINES.length; i++) {
    if (state.completedBingos.has(i)) continue;
    const line = BINGO_LINES[i];
    if (!line.includes(cellIdx)) continue;
    if (lineHasPermanentlyDeadCell(state, line)) continue;
    const othersDone = line.every((c) => {
      if (c === cellIdx) return true;
      const cell = state.cells[c];
      return cell.state === "revealed" && cell.scored;
    });
    if (othersDone) count += 1;
  }
  return count;
}

// Partial-line credit: for each incomplete bingo line containing `cellIdx`,
// sum (donesOthers / 4)^2 where donesOthers = revealed-and-scored OTHER cells.
// Squared so near-complete lines (3/4 done) dominate fresh ones (0/4 done).
// Lines that this flip COMPLETES on its own are excluded — those are already
// credited by `bingoLinesCompletedBy` × 10. Only counts cells that are
// revealed AND scored, mirroring the game's bingo rule.
function bingoLineProgress(state, cellIdx) {
  let total = 0;
  for (let i = 0; i < BINGO_LINES.length; i++) {
    if (state.completedBingos.has(i)) continue;
    const line = BINGO_LINES[i];
    if (!line.includes(cellIdx)) continue;
    if (lineHasPermanentlyDeadCell(state, line)) continue;
    let done = 0;
    let othersHidden = 0;
    for (const c of line) {
      if (c === cellIdx) continue;
      const cell = state.cells[c];
      if (cell.state === "revealed" && cell.scored) done += 1;
      else if (cell.state === "hidden") othersHidden += 1;
    }
    // If every other cell is already done, this flip completes the line —
    // bingoLinesCompletedBy will credit it. Don't double-count.
    if (othersHidden === 0 && done === 4) continue;
    const ratio = done / 4;
    total += ratio * ratio;
  }
  return total;
}

// Expected immediate value (points for this flip) of flipping `cellIdx`.
// Does NOT lookahead into chain continuation value — chain potential is added
// separately as a small heuristic bonus.
function expectedImmediatePoints(hand, distribution) {
  let ev = 0;
  for (const v of VALUES) {
    const p = distribution[v] ?? 0;
    if (p === 0) continue;
    const cmp = compareHandVsRevealed(hand, v);
    if (cmp === "score" || cmp === "chain") ev += p * pointsFor(v);
  }
  return ev;
}

// Probability that the turn CONTINUES after flipping this cell with `hand`.
function probChainContinues(hand, distribution) {
  let p = 0;
  for (const v of VALUES) {
    const cmp = compareHandVsRevealed(hand, v);
    if (cmp === "chain") p += distribution[v] ?? 0;
  }
  return p;
}

// Score a candidate flip for the current hand.
function scoreCell(state, cellIdx, hand, pFive, distribution, placements, w) {
  const dist = distribution.get(cellIdx);
  const bingoBonus = bingoLinesCompletedBy(state, cellIdx) * 10;
  const phase = phaseFor(state);

  if (hand === "K") {
    // Only value is catching the King.
    const pK = dist.K ?? 0;
    const centerBias = -centerDistance(cellIdx) * w.centerTiebreak;
    return {
      score: pK * 100 + bingoBonus + centerBias,
      detail: { pK, bingoBonus },
    };
  }

  const ev = expectedImmediatePoints(hand, dist);
  const chainP = probChainContinues(hand, dist);
  const bingoProgressW = pick(w, "bingoProgressWeight", phase);
  const bingoProgressBonus = bingoProgressW
    ? bingoLineProgress(state, cellIdx) * bingoProgressW
    : 0;
  // Real Shannon info gain (bits) about the 5-placement, exact from the
  // constraint enumeration. When no placements are available (degenerate
  // states with no remaining 5s), fall back to the cell's own value entropy.
  const bits = placements && placements.length > 1
    ? infoGainAboutFives(cellIdx, placements)
    : valueUncertainty(dist);
  const infoBonus = bits * pick(w, "infoWeight", phase);
  const centerBias = -centerDistance(cellIdx) * w.centerTiebreak;
  const spreadW = pick(w, "spreadWeight", phase);
  const spreadBonus = spreadW ? spreadCount(state, cellIdx) * spreadW : 0;
  const pK = dist.K ?? 0;
  const p5 = dist[5] ?? 0;
  // Note: no penalty for revealing K early — the K-turn can still click the
  // K-card on a face-up K to score 100.
  const kPenalty = 0;
  // Bonus for flipping cells likely to BE the King. When hand is not K, the
  // reveal converts the K-turn from a probability-weighted guess into a
  // guaranteed +100. Weight scales with distance to the 550 target so it
  // dominates decisions when we actually need K to reach gold.
  const kHuntBonus = hand !== "K" ? pK * kHuntWeight(state, w, phase) : 0;

  const remaining = state.remaining;
  const totalRemaining =
    remaining[1] + remaining[2] + remaining[3] + remaining[4] + remaining[5] + remaining.K;
  const avgPts = totalRemaining
    ? (remaining[1] * 10 +
        remaining[2] * 20 +
        remaining[3] * 30 +
        remaining[4] * 40 +
        remaining[5] * 50 +
        remaining.K * 100) /
      totalRemaining
    : 0;
  // Chain expectation: when the current flip chains (hand > revealed), the
  // player gets to flip again. The expected total from continuation is
  // ~chainP/(1-chainP) * ev of the typical next flip — we approximate that
  // "typical next ev" with the remaining-card average, scaled by
  // chainBonusMul. A multiplier of 1.0 is still conservative vs. a full
  // geometric sum, but high enough that chain-heavy flips (e.g. hand=4 on a
  // safe unsafe-for-5 cell) correctly beat a same-value catch that ends
  // the turn.
  const chainBonus = chainP * avgPts * pick(w, "chainBonusMul", phase);

  // A cell will almost certainly be captured during the 5-turn if it's either
  // already safe-for-5 (no catch risk) or a deduced 5 (player can flip it once
  // its neighbors are cleared). In those cases, the bingo bonus and most of
  // the point value are ALREADY priced into the 5-turn — don't double-credit
  // by rewarding an early flip for them.
  const reservedFor5Turn =
    hand !== "5" && fiveAhead(state) && (p5 >= 0.999 || isSafeFor5Turn(state, cellIdx, null, pFive));

  let score;
  let detail;
  if (reservedFor5Turn) {
    const evLater = p5 >= 0.999 ? 50 : expectedPointsIfFiveTurn(dist);
    // Net value of flipping now vs. letting the 5-turn handle it. Bingo and
    // chain roughly cancel because both turns get them. Info is lost if we
    // wait, so it stays on the "now" side. K-hunt bonus applies equally: the
    // 5-turn might not reach this cell before the K-turn begins, so revealing
    // K now is still a net gain.
    score = ev - evLater + infoBonus + spreadBonus + bingoProgressBonus + centerBias - kPenalty + kHuntBonus;
    detail = { ev, evLater, infoBonus, spreadBonus, bingoProgressBonus, kPenalty, kHuntBonus, reserved: true };
  } else {
    score = ev + chainBonus + bingoBonus + bingoProgressBonus + infoBonus + spreadBonus + centerBias - kPenalty + kHuntBonus;
    detail = { ev, chainP, chainBonus, bingoBonus, bingoProgressBonus, infoBonus, spreadBonus, kPenalty, kHuntBonus };
    if (hand === "5") {
      const pCatch = probAnyNeighborIsFive(state, cellIdx, placements);
      score -= pCatch * w.catchPenalty;
      detail.pCatch = pCatch;
    }
  }
  return { score, detail };
}

function describeReason(state, hand, cellIdx, detail) {
  if (detail.kind === "catch") {
    return t("catchSameValueReason", { value: detail.value, points: detail.points });
  }
  if (hand === "K") {
    if (detail.pK >= 0.999) return t("kingHereReason", { bingoBonus: detail.bingoBonus });
    return t("pKingReason", { pct: (detail.pK * 100).toFixed(1), bingoBonus: detail.bingoBonus });
  }
  const parts = [];
  if (detail.reserved) {
    parts.push(t("reservedReason", { lost: (detail.evLater - detail.ev).toFixed(1) }));
    if (detail.infoBonus) parts.push(t("infoReason", { bonus: detail.infoBonus.toFixed(1) }));
  } else {
    parts.push(t("evReason", { ev: detail.ev.toFixed(1) }));
    if (detail.chainP > 0) parts.push(t("chainReason", { pct: (detail.chainP * 100).toFixed(0) }));
    if (detail.infoBonus) parts.push(t("infoReason", { bonus: detail.infoBonus.toFixed(1) }));
    if (detail.bingoBonus) parts.push(t("bingoReason", { bonus: detail.bingoBonus }));
    if (hand === "5" && detail.pCatch != null) {
      parts.push(t("catchRiskReason", { pct: (detail.pCatch * 100).toFixed(0) }));
    }
  }
  if (detail.kHuntBonus && detail.kHuntBonus > 0.5) {
    parts.push(t("kHuntReason", { bonus: detail.kHuntBonus.toFixed(1) }));
  }
  return parts.join(", ");
}

export function suggestMove(state, weights = DEFAULT_WEIGHTS, options = {}) {
  const hand = currentCard(state);
  if (!hand) return null;

  // Hardcoded opener — only on hand=1 turns. Skips already-revealed cells so
  // mid-game undo / manual reveals don't cause infinite suggestions.
  // Early-exit when every hidden cell that could still be a 5 is already
  // adjacent to a revealed cell: the existing flash signals already cover
  // all possible 5 locations, so further opener flips can't refine the
  // 5-map. Hand off to the heuristic, which can pick a more EV-rich flip.
  // `options.forceFullOpener` is an offline benchmarking knob to disable
  // that early-exit and measure its contribution.
  const openerEarlyExit = !options.forceFullOpener && fivesFullyInformed(state);
  const openerPattern = options.openerPattern ?? OPENING_PATTERN;
  // If the user has revealed any cell that ISN'T part of the opener, they've
  // already deviated — drop the opener entirely and let the heuristic pick.
  // The pattern only pays off as a coordinated multi-flip; finishing the
  // remaining opener cells out of context loses the property that makes it
  // good. Recomputed each call so undo restores opener mode automatically.
  const openerDeviated = state.cells.some(
    (c, i) => c.state === "revealed" && !openerPattern.includes(i),
  );
  if (
    !options.disableOpener &&
    hand === "1" &&
    state.handIndex < openerPattern.length &&
    !openerEarlyExit &&
    !openerDeviated
  ) {
    for (const idx of openerPattern) {
      if (state.cells[idx].state === "hidden") {
        return {
          cellIdx: idx,
          score: 0,
          reason: t("openingReason"),
        };
      }
    }
  }

  // Late game: hand off to expectimax. The search budget bounds branching
  // so we degrade gracefully on dense states; if it bails out (exhausted)
  // we fall back to the heuristic for this decision.
  if (state.handIndex >= SEARCH_TRIGGER_HAND_INDEX && !options.skipSearch) {
    let hiddenCount = 0;
    for (let i = 0; i < state.cells.length; i++) {
      if (state.cells[i].state === "hidden") hiddenCount += 1;
    }
    // Switch to a P(gold)-dominant objective when the game is below
    // target — the search would otherwise pick the highest-E[score] move
    // even if a lower-mean / higher-variance move had a better chance of
    // crossing 550. Above target, max E[score] is fine. The gold leaf
    // prunes harder, so we can afford a wider hidden-cell ceiling and a
    // bigger node budget below target. `options.searchObjective =
    // "score"` forces the legacy E[score] path for offline A/B.
    const belowTarget = state.score < SCORE_TARGET;
    const defaultObjective = belowTarget ? "gold" : "score";
    const objective = options.searchObjective ?? defaultObjective;
    const maxHidden = objective === "gold" ? SEARCH_MAX_HIDDEN_GOLD : SEARCH_MAX_HIDDEN;
    const nodeBudget = objective === "gold" ? SEARCH_NODE_BUDGET_GOLD : SEARCH_NODE_BUDGET;
    if (hiddenCount <= maxHidden) {
      const r = suggestMoveSearch(state, { maxNodes: nodeBudget, objective });
      if (r && !r.searchExhausted) return r;
    }
  }

  // On the K-turn, clicking the K-card on the King (face-down OR already
  // face-up) catches it for +100. If the K is already revealed, point the
  // player directly at that cell instead of making them guess face-downs.
  if (hand === "K" && state.remaining.K === 0) {
    for (let i = 0; i < state.cells.length; i++) {
      const c = state.cells[i];
      if (c.state === "revealed" && c.value === "K" && !c.scored) {
        return {
          cellIdx: i,
          score: 100,
          reason: t("clickKKingReason"),
        };
      }
    }
  }

  // Pre-compute these once — used by both the catch-safety check below and
  // the face-down scoring loop further down.
  const pFiveForCatch = hand === "5" ? fiveProbabilities(state) : null;

  // Chain catches: revealed-but-unscored cells with value strictly below the
  // current hand are free points that keep the turn alive. Always do these
  // before any face-down flip — they're guaranteed score. For hand=5 we
  // additionally require the cell to be safe-for-5: any adjacent 5 (revealed
  // or still-hidden must-be-5) triggers the catch mechanic and would wipe the
  // attempt.
  let bestChainCatch = null;
  for (let i = 0; i < state.cells.length; i++) {
    const cell = state.cells[i];
    if (cell.state !== "revealed" || cell.scored) continue;
    const cmp = compareHandVsRevealed(hand, cell.value);
    if (cmp !== "chain") continue;
    if (hand === "5" && !isSafeFor5Turn(state, i, null, pFiveForCatch)) continue;
    if (!bestChainCatch || pointsFor(cell.value) > pointsFor(bestChainCatch.value)) {
      bestChainCatch = { cellIdx: i, value: cell.value };
    }
  }
  if (bestChainCatch) {
    const pts = pointsFor(bestChainCatch.value);
    return {
      cellIdx: bestChainCatch.cellIdx,
      score: pts,
      reason: t("catchChainReason", { value: bestChainCatch.value, points: pts }),
    };
  }

  const hidden = hiddenCells(state);
  const pFive = fiveProbabilities(state);
  const distribution = cellValueDistribution(state);
  // One-time enumeration of all consistent 5-placements. Used by the new
  // exact info-gain term in scoreCell — passed in rather than recomputed
  // per cell because enumeration is O(C(candidates, remaining-5s)).
  const placements = enumerate5Placements(state);

  let bestCell = null;
  let bestScore = -Infinity;
  let bestDetail = null;
  for (const idx of hidden) {
    const { score, detail } = scoreCell(state, idx, hand, pFive, distribution, placements, weights);
    if (score > bestScore) {
      bestScore = score;
      bestCell = idx;
      bestDetail = detail;
    }
  }

  // Same-value catches: revealed-unscored cells whose value equals the current
  // hand card. They guarantee points but end the turn. Only worthwhile when no
  // HIGHER hand card can later chain-catch the same cell (since a chain catch
  // keeps the turn alive while banking the same points).
  //   hand=2 catching a 2: skip — hand=3 chain-catches it freely.
  //   hand=3 catching a 3: skip — hand=4 chain-catches it freely.
  //   hand=4 catching a 4: only if the cell is UNSAFE for the 5-turn
  //                         (hand=5 wouldn't be able to chain-catch safely).
  //   hand=5 catching a 5: yes, if the cell is safe-for-5 (otherwise caught).
  //   hand=K catching a K: always — it's the game's endpoint.
  for (let i = 0; i < state.cells.length; i++) {
    const cell = state.cells[i];
    if (cell.state !== "revealed" || cell.scored) continue;
    const cmp = compareHandVsRevealed(hand, cell.value);
    if (cmp !== "score") continue;
    if (hand === "5" && !isSafeFor5Turn(state, i, null, pFive)) continue;
    const basePts = pointsFor(cell.value);
    let futureChainAvailable = false;
    if (hand === "2" || hand === "3") {
      futureChainAvailable = true;
    } else if (hand === "4" && isSafeFor5Turn(state, i, null, pFive)) {
      futureChainAvailable = true;
    }
    const score = futureChainAvailable ? 0 : basePts;
    if (score > bestScore) {
      bestScore = score;
      bestCell = i;
      bestDetail = { kind: "catch", value: cell.value, points: basePts, futureChainAvailable };
    }
  }

  if (bestCell == null) return null;

  return {
    cellIdx: bestCell,
    score: bestScore,
    reason: describeReason(state, hand, bestCell, bestDetail),
    pFive,
    distribution,
  };
}
