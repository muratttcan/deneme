// Pure state model for the Metin2 Okey card minigame.
// 24 unique cards: values 1..8 across three colors (R/B/Y). The game shows 5
// cards on the field; you can either discard cards (any subset, even just one)
// to draw replacements, or pick 3 to score. There's no fixed round structure —
// you keep playing until you decide to finish.
//
// No DOM, no I/O. Exports state/transition functions consumed by ui + solver.

export const COLORS = ["R", "B", "Y"];
export const COLOR_NAMES = { R: "Red", B: "Blue", Y: "Yellow" };
export const VALUES = [1, 2, 3, 4, 5, 6, 7, 8];
export const BOARD_SIZE = 5;
export const HAND_SIZE = 3;

export const CHEST_THRESHOLDS = { gold: 400, silver: 300, bronze: 0 };

export function cardId(color, value) { return `${color}${value}`; }
export function parseCardId(id) {
  return { color: id[0], value: Number(id.slice(1)) };
}

// ----- scoring -----
//
// Three-of-a-kind (all same value, any colors): 20 + (value-1) * 10
//   1→20, 2→30, …, 8→90
// Same-color sequence (3 consecutive, all same color):
//   low=1 → 50, low=2 → 60, …, low=6 → 100  (formula: 50 + (low-1)*10)
// Mixed-color sequence (3 consecutive, NOT all same color):
//   low=1 → 10, low=2 → 20, …, low=6 → 60   (formula: low * 10)
// No combination → 0.

export function scoreThreeOfAKind(value) {
  return 20 + (value - 1) * 10;
}
export function scoreSameColorSeq(low) {
  return 50 + (low - 1) * 10;
}
export function scoreMixedSeq(low) {
  return low * 10;
}

// Score a 3-card hand. Returns { score, type, label } where type ∈
// {"three", "sameSeq", "mixedSeq", "none"} and label is human-readable.
export function scoreHand(cards) {
  if (!cards || cards.length !== 3) return { score: 0, type: "none", label: "—" };
  const parsed = cards.map(parseCardId);
  const values = parsed.map((c) => c.value).sort((a, b) => a - b);
  const colors = parsed.map((c) => c.color);

  if (values[0] === values[1] && values[1] === values[2]) {
    const v = values[0];
    return { score: scoreThreeOfAKind(v), type: "three", label: `Three ${v}s` };
  }

  const isSeq = values[1] === values[0] + 1 && values[2] === values[1] + 1;
  if (isSeq) {
    const low = values[0];
    const allSameColor = colors[0] === colors[1] && colors[1] === colors[2];
    if (allSameColor) {
      return { score: scoreSameColorSeq(low), type: "sameSeq", label: `${low}-${low + 1}-${low + 2} same color` };
    }
    return { score: scoreMixedSeq(low), type: "mixedSeq", label: `${low}-${low + 1}-${low + 2} mixed` };
  }

  return { score: 0, type: "none", label: "No combo" };
}

export function chestForScore(score) {
  if (score >= CHEST_THRESHOLDS.gold) return "gold";
  if (score >= CHEST_THRESHOLDS.silver) return "silver";
  return "bronze";
}

// ----- state -----
//
// board:    array of 5 slots, each cardId or null
// score:    running score for the current game
// consumed: Set of cardIds permanently out of the deck this game (discarded
//           or scored) — these stay greyed in the palette
// history:  stack of past actions (for undo)
// log:      confirmed picks for the current game (in order)

export function createState() {
  return {
    board: Array(BOARD_SIZE).fill(null),
    score: 0,
    consumed: new Set(),
    history: [],
    log: [],
  };
}

export function setSlot(state, slotIndex, cardId) {
  if (slotIndex < 0 || slotIndex >= BOARD_SIZE) return state;
  state.history.push({ kind: "setSlot", slotIndex, prev: state.board[slotIndex] });
  state.board[slotIndex] = cardId;
  return state;
}

export function clearSlot(state, slotIndex) {
  return setSlot(state, slotIndex, null);
}

// discardSlot: remove the card AND mark it as consumed (out of deck for the
// rest of this game). Distinct from clearSlot, which just empties the slot
// without affecting the deck — that path is reserved for setSlot/undo.
export function discardSlot(state, slotIndex) {
  const card = state.board[slotIndex];
  if (!card) return false;
  state.history.push({ kind: "discard", slotIndex, card });
  state.consumed.add(card);
  state.board[slotIndex] = null;
  return true;
}

export function firstEmptySlot(state) {
  return state.board.findIndex((c) => c === null);
}

// addCard: place into the first empty slot. Returns slot index used, or -1
// if board is full.
export function addCard(state, cardId) {
  const idx = firstEmptySlot(state);
  if (idx < 0) return -1;
  setSlot(state, idx, cardId);
  return idx;
}

// confirmPick: lock in a 3-card selection, score it, remove the picked cards
// from the board. Returns {gained, hand, type, label}.
export function confirmPick(state, pickedSlots) {
  if (!pickedSlots || pickedSlots.length !== HAND_SIZE) {
    return { gained: 0, hand: [], type: "none", label: "Need 3 cards" };
  }
  const hand = pickedSlots.map((i) => state.board[i]);
  if (hand.some((c) => !c)) {
    return { gained: 0, hand: [], type: "none", label: "Empty slots in pick" };
  }
  const { score: gained, type, label } = scoreHand(hand);

  state.history.push({
    kind: "confirm",
    prevBoard: [...state.board],
    prevScore: state.score,
    pickedSlots: [...pickedSlots],
    hand: [...hand],
    gained, type, label,
  });

  // Picked cards leave the board AND the deck — scored cards never come back.
  for (const i of pickedSlots) {
    state.consumed.add(state.board[i]);
    state.board[i] = null;
  }
  state.score += gained;
  state.log.push({ hand, gained, type, label });

  return { gained, hand, type, label };
}

export function undo(state) {
  // Step over auto-fills from practice mode — they belong to the prior user
  // action, not their own undo step. Without this, undo would unwind one
  // random draw at a time, which feels broken to the user.
  while (state.history.length > 0 && state.history[state.history.length - 1].auto) {
    const auto = state.history.pop();
    if (auto.kind === "setSlot") state.board[auto.slotIndex] = auto.prev;
  }
  const last = state.history.pop();
  if (!last) return false;
  if (last.kind === "setSlot") {
    state.board[last.slotIndex] = last.prev;
    return true;
  }
  if (last.kind === "discard") {
    state.board[last.slotIndex] = last.card;
    state.consumed.delete(last.card);
    return true;
  }
  if (last.kind === "confirm") {
    state.board = last.prevBoard;
    state.score = last.prevScore;
    state.log.pop();
    for (const c of last.hand) state.consumed.delete(c);
    return true;
  }
  return false;
}

export function resetState(state) {
  state.board = Array(BOARD_SIZE).fill(null);
  state.score = 0;
  state.consumed = new Set();
  state.history = [];
  state.log = [];
}

export function isBoardFull(state) {
  return state.board.every((c) => c !== null);
}

export function filledCards(state) {
  return state.board.filter((c) => c !== null);
}

// Set of card IDs the palette should grey out — currently-on-board union with
// consumed (discarded or scored). Both are out of the deck for this game.
export function usedCardSet(state) {
  const out = new Set(state.consumed);
  for (const c of state.board) if (c) out.add(c);
  return out;
}

// Cards still in the deck (not on the board and not consumed). Used by the
// solver for discard EV and by practice mode for random draws.
export function deckRemaining(state) {
  const used = usedCardSet(state);
  const out = [];
  for (const color of COLORS) {
    for (const v of VALUES) {
      const id = `${color}${v}`;
      if (!used.has(id)) out.push(id);
    }
  }
  return out;
}

// Practice mode: fill empty slots with random cards from deckRemaining.
// History entries get `auto: true` so undo() can step over them and treat
// the entire user-action-plus-refill as one "round" boundary.
//
// `rand` is plug-in for testing; defaults to Math.random.
export function autoFillBoardFromDeck(state, rand = Math.random) {
  while (true) {
    const slot = firstEmptySlot(state);
    if (slot < 0) break;
    const deck = deckRemaining(state);
    if (deck.length === 0) break;
    const card = deck[Math.floor(rand() * deck.length)];
    state.history.push({ kind: "setSlot", slotIndex: slot, prev: null, auto: true });
    state.board[slot] = card;
  }
}
