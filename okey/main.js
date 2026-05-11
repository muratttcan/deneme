// Wires okey-game state, okey-solver suggestions, and okey-ui rendering.
// No round structure — score accumulates until the user resets, which logs
// the final score into the session stats.

import {
  createState, addCard, discardSlot, confirmPick, undo, resetState,
  usedCardSet, autoFillBoardFromDeck, BOARD_SIZE, HAND_SIZE, chestForScore,
} from "./game.js";
import { suggestMove } from "./solver.js";
import {
  renderBoard, renderPalette, updateSidebar, updateSessionStats,
} from "./ui.js";

const els = {
  board: document.getElementById("board"),
  palette: document.getElementById("palette"),
  score: document.getElementById("score"),
  scoreCeiling: document.getElementById("scoreCeiling"),
  chestProjection: document.getElementById("chestProjection"),
  pickTotal: document.getElementById("pickTotal"),
  pickLabel: document.getElementById("pickLabel"),
  suggestionNote: document.getElementById("suggestionNote"),
  practiceToggle: document.getElementById("practiceToggle"),
  confirmBtn: document.getElementById("confirmBtn"),
  acceptSuggestionBtn: document.getElementById("acceptSuggestionBtn"),
  undoBtn: document.getElementById("undoBtn"),
  resetBtn: document.getElementById("resetBtn"),
  sessionGames: document.getElementById("sessionGames"),
  sessionGold: document.getElementById("sessionGold"),
  sessionSilver: document.getElementById("sessionSilver"),
  sessionBronze: document.getElementById("sessionBronze"),
  sessionPctGold: document.getElementById("sessionPctGold"),
  sessionPctSilver: document.getElementById("sessionPctSilver"),
  sessionPctBronze: document.getElementById("sessionPctBronze"),
  sessionAvg: document.getElementById("sessionAvg"),
  sessionResetBtn: document.getElementById("sessionResetBtn"),
  toast: document.getElementById("toast"),
  twitchChatMount: document.getElementById("twitchChatMount"),
  chatBtn: document.getElementById("chatBtn"),
  minimalUiBtn: document.getElementById("minimalUiBtn"),
};

// ---------- state ----------

const state = createState();
let pickedSlots = new Set();
let session = loadSession();
let practiceMode = loadPracticeMode();

const PRACTICE_KEY = "okey-helper.practice.v1";
function loadPracticeMode() {
  try { return localStorage.getItem(PRACTICE_KEY) === "1"; } catch { return false; }
}
function savePracticeMode() {
  try { localStorage.setItem(PRACTICE_KEY, practiceMode ? "1" : "0"); } catch {}
}

// ---------- session persistence ----------

const SESSION_KEY = "okey-helper.session.v1";
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return emptySession();
    return { ...emptySession(), ...JSON.parse(raw) };
  } catch { return emptySession(); }
}
function saveSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
}
function emptySession() {
  return { games: 0, gold: 0, silver: 0, bronze: 0, totalScore: 0 };
}

// ---------- handlers ----------

function onPaletteClick(cardId) {
  const slot = addCard(state, cardId);
  if (slot < 0) {
    toast("Field is full — pick 3 to score, or discard a card first.");
    return;
  }
  refresh();
}

function onSlotClick(slotIndex) {
  const card = state.board[slotIndex];
  if (!card) return;

  // Toggle selection. Replacing the oldest pick when the user already has 3
  // selected feels nicer than ignoring the click.
  if (pickedSlots.has(slotIndex)) {
    pickedSlots.delete(slotIndex);
  } else if (pickedSlots.size < HAND_SIZE) {
    pickedSlots.add(slotIndex);
  } else {
    const first = pickedSlots.values().next().value;
    pickedSlots.delete(first);
    pickedSlots.add(slotIndex);
  }
  refresh();
}

// Right-click on a slot = discard that card. Goes into state.consumed so it
// stays greyed in the palette for the rest of this game.
function onSlotRightClick(slotIndex) {
  if (!state.board[slotIndex]) return;
  pickedSlots.delete(slotIndex);
  discardSlot(state, slotIndex);
  refresh();
}

function onConfirm() {
  if (pickedSlots.size !== HAND_SIZE) {
    toast(`Select ${HAND_SIZE} cards first.`);
    return;
  }
  const r = confirmPick(state, [...pickedSlots]);
  pickedSlots.clear();
  if (r.gained > 0) toast(`+${r.gained} (${r.label})`);
  else toast(`No combo — 0 points`);
  refresh();
}

function onAcceptSuggestion() {
  const move = suggestMove(state);
  if (!move) { toast("Add cards to the field first."); return; }
  if (move.kind === "pick") {
    pickedSlots = new Set(move.slots);
    refresh();
    return;
  }
  // Discard: actually perform the discards. Sort descending so each splice-
  // equivalent doesn't shift the next index — discardSlot leaves slot positions
  // alone, so order doesn't matter, but consistency is nice.
  pickedSlots.clear();
  const slotsDesc = [...move.slots].sort((a, b) => b - a);
  for (const i of slotsDesc) discardSlot(state, i);
  toast(`Discarded ${move.slots.length} — enter the new card${move.slots.length === 1 ? "" : "s"} from the game.`);
  refresh();
}

function onUndo() {
  if (!undo(state)) { toast("Nothing to undo."); return; }
  pickedSlots.clear();
  refresh();
}

// Reset = "this game is over, log it, start fresh". A run with no scoring
// picks doesn't count toward session stats — that'd inflate the bronze rate.
function onReset() {
  const finalScore = state.score;
  const hadPicks = state.log.length > 0;
  if (hadPicks) {
    const tier = chestForScore(finalScore);
    session.games += 1;
    session[tier] += 1;
    session.totalScore += finalScore;
    saveSession();
    updateSessionStats(els, session);
    toast(`Game over — ${tier} chest (${finalScore} pts)`);
  }
  resetState(state);
  pickedSlots.clear();
  refresh();
}

function onSessionReset() {
  session = emptySession();
  saveSession();
  updateSessionStats(els, session);
}

// ---------- toast ----------
let toastTimer = 0;
function toast(msg) {
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.classList.add("toast-show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("toast-show"), 1800);
}

// ---------- refresh ----------

function refresh() {
  // Practice mode: any time the board has empty slots and the deck still has
  // cards, auto-draw to keep the field at 5. Single place handles all cases
  // (after confirm, after discard, after toggle, after reset).
  if (practiceMode) autoFillBoardFromDeck(state);

  const move = suggestMove(state);
  const suggested = move ? new Set(move.slots) : null;
  const suggestionKind = move ? move.kind : null;

  renderBoard(els.board, state, { picked: pickedSlots, suggested, suggestionKind, onSlotClick });
  els.board.querySelectorAll(".slot").forEach((slot, i) => {
    slot.addEventListener("contextmenu", (e) => { e.preventDefault(); onSlotRightClick(i); });
  });

  renderPalette(els.palette, {
    onPaletteClick: practiceMode ? null : onPaletteClick,
    usedCards: usedCardSet(state),
    practiceMode,
  });
  updateSidebar(els, state, { picked: pickedSlots });

  els.suggestionNote.textContent = move ? move.reasoning : "Add cards to the field to see a suggestion.";
  els.acceptSuggestionBtn.disabled = !move;
  if (move && move.kind === "discard") {
    const k = move.slots.length;
    els.acceptSuggestionBtn.textContent = `Discard ${k} card${k === 1 ? "" : "s"}`;
  } else {
    els.acceptSuggestionBtn.textContent = "Use suggestion";
  }
  els.confirmBtn.disabled = pickedSlots.size !== HAND_SIZE;
  els.undoBtn.disabled = state.history.length === 0;
}

// ---------- keyboard ----------

let pendingColor = null;
document.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;

  if (e.key === "Backspace") { e.preventDefault(); onUndo(); return; }
  if (e.key === "Escape")    { onReset(); return; }
  if (e.key === "Enter")     { onConfirm(); return; }
  if (e.key === " ")         { e.preventDefault(); onAcceptSuggestion(); return; }

  const k = e.key.toUpperCase();
  if (k === "R" || k === "B" || k === "Y") { pendingColor = k; return; }
  if (pendingColor && /^[1-8]$/.test(e.key)) {
    onPaletteClick(`${pendingColor}${e.key}`);
    pendingColor = null;
  }
});

// ---------- twitch chat embed ----------

function mountTwitchChat() {
  if (!els.twitchChatMount) return;
  const host = location.hostname || "localhost";
  const parents = new Set([host, "localhost", "127.0.0.1"]);
  const parentParams = [...parents].map((p) => `parent=${encodeURIComponent(p)}`).join("&");
  const iframe = document.createElement("iframe");
  iframe.src = `https://www.twitch.tv/embed/jogoe/chat?darkpopout&${parentParams}`;
  iframe.title = "Twitch chat for jogoe";
  iframe.allow = "autoplay; encrypted-media";
  els.twitchChatMount.appendChild(iframe);
}

// ---------- toggles ----------

function bindToggles() {
  if (els.chatBtn) {
    els.chatBtn.addEventListener("click", () => document.body.classList.toggle("chat-hidden"));
  }
  if (els.minimalUiBtn) {
    els.minimalUiBtn.addEventListener("click", () => {
      document.body.classList.toggle("minimal-ui");
      els.minimalUiBtn.classList.toggle("off", !document.body.classList.contains("minimal-ui"));
    });
  }
}

// ---------- practice mode toggle ----------

function onPracticeToggle() {
  practiceMode = els.practiceToggle.checked;
  savePracticeMode();
  document.body.classList.toggle("practice-on", practiceMode);
  // Toggling clears selection — the board is about to mutate either way.
  pickedSlots.clear();
  refresh();
}

// ---------- bootstrap ----------

els.confirmBtn.addEventListener("click", onConfirm);
els.acceptSuggestionBtn.addEventListener("click", onAcceptSuggestion);
els.undoBtn.addEventListener("click", onUndo);
els.resetBtn.addEventListener("click", onReset);
els.sessionResetBtn.addEventListener("click", onSessionReset);
els.practiceToggle.checked = practiceMode;
els.practiceToggle.addEventListener("change", onPracticeToggle);
document.body.classList.toggle("practice-on", practiceMode);
bindToggles();
mountTwitchChat();
updateSessionStats(els, session);
refresh();
