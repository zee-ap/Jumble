/****************************************************
 * app.js (FULL)
 * - Word of the Day (works)
 * - Competition Mode (REAL WebSockets):
 *   - Create room (server)
 *   - Join room (server)
 *   - Waiting rooms show players live
 *   - "Ready" button (all players)
 *   - Ready checkmarks in player list
 *   - Auto start when room full + all ready
 * - Multiplayer gameplay:
 *   - Starts on start_match
 *   - Guess via WebSocket (action:"guess")
 *   - Live scoreboard via match_state
 *   - Match over via match_over
 ****************************************************/

/****************************************************
 * GLOBAL GAME STATE (Word of the Day)
 ****************************************************/
let currentRow = 0;
let currentCol = 0;
let gameOver = false;
let isSubmitting = false;

const keyRank = { absent: 1, present: 2, correct: 3 };
let keyState = {};

let messageTimer = null;

/****************************************************
 * COMPETITION STATE
 ****************************************************/
let selectedMode = null;   // "sprint" | "point"
let roomCode = null;
let players = [];
let maxPlayers = 0;

let mpRow = 0;
let mpCol = 0;
let mpGuesses = [];
let mpCurrentResultRows = [];
let mpActive = false;
let mpInputLocked = false;

let myName = null;
let ws = null;
let inputLocked = false;
let myToken = null;
const STORAGE_ROOM = "jumble_room";
const STORAGE_DAILY = "jumble_daily";
let dailyCountdownUntil = null;
let mpStatusTimer = null;
let mpEndOpen = false;
let mpRoundReadyPending = false;
const ROUND_PAUSE_MS = 3000;
let roundWaitTimer = null;

/****************************************************
 * APP STARTUP
 ****************************************************/
document.addEventListener("DOMContentLoaded", initApp);

function initApp() {
  bindMenuButtons();
  bindKeyboard();
  document.addEventListener("keydown", handleKey);
  showScreen("menu");
  // Only auto-restore/rejoin on browser refresh (not fresh visits).
  tryAutoResumeOnRefresh();
}

/****************************************************
 * WEBSOCKET HELPERS
 ****************************************************/
function ensureWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${window.location.host}/ws`);

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWSMessage(msg);
  };

  ws.onerror = () => {
    alert("WebSocket error. Check server is running.");
  };

  ws.onclose = () => {
    if (mpEndOpen) return;
    mpActive = false;
    mpInputLocked = true;
    clearRoomState();
    showScreen("menu");
    clearMenuMessage();
  };
}

function wsSend(payload) {
  ensureWS();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("WebSocket not connected yet. Try again.");
    return;
  }
  ws.send(JSON.stringify(payload));
}

function handleWSMessage(msg) {
  if (msg.type === "error") {
    alert(msg.error || "Server error");
    if ((msg.error || "").toLowerCase().includes("room not found") ||
        (msg.error || "").toLowerCase().includes("player not found")) {
      clearRoomIdentity();
      clearMenuMessage();
    }
    return;
  }

  if (msg.type === "created" || msg.type === "joined" || msg.type === "room_state") {
    roomCode = msg.roomCode;
    selectedMode = msg.mode;
    players = msg.players || [];
    maxPlayers = msg.maxPlayers || 0;
    if (msg.token) {
      myToken = msg.token;
      persistRoomIdentity();
    }

    openDuelWaitingRoom();

    updateWaitingUI();
    return;
  }

  if (msg.type === "rejoined") {
    roomCode = msg.roomCode;
    selectedMode = msg.mode;
    players = msg.players || [];
    maxPlayers = msg.maxPlayers || 0;

    if (msg.started) {
      mpActive = false;
      mpInputLocked = true;
      mpRow = 0;
      mpCol = 0;
      mpGuesses = [];
      mpCurrentResultRows = [];

      const title = document.getElementById("mp-title");
      if (title) {
        const pretty = msg.mode === "sprint" ? "Duel • Sprint" :
                       msg.mode === "point" ? "Duel • Point" : "Match";
        title.textContent = pretty;
      }

      showScreen("screen-multiplayer");
      createMpGrid();
      createMpKeyboard();
      renderMpScoreboard(msg.players || []);
      setMpStatus("Rejoined match ✅", 3000);
      const startAtMs = (typeof msg.startAt === "number") ? msg.startAt * 1000 : 0;
      if (startAtMs > Date.now()) {
        runCountdownUntil(document.getElementById("mp-countdown"), startAtMs, () => {
          mpActive = selectedMode !== "point";
          mpInputLocked = selectedMode === "point";
          mpShowMessage("Go! Type your guesses.");
        });
      } else {
        mpActive = selectedMode !== "point";
        mpInputLocked = selectedMode === "point";
        mpShowMessage("You rejoined the match.");
      }
      return;
    }

    openDuelWaitingRoom();
    updateWaitingUI();
    return;
  }

  // ✅ REAL TRANSITION INTO MULTIPLAYER GAMEPLAY
  if (msg.type === "start_match") {
    hideMpEndScreen();
    hideMpWaitScreen();
    mpActive = false;
    mpInputLocked = true;
    mpRow = 0;
    mpCol = 0;
    mpGuesses = [];
    mpCurrentResultRows = [];

    const title = document.getElementById("mp-title");
    if (title) {
      const pretty = msg.mode === "sprint" ? "Duel • Sprint" :
                     msg.mode === "point" ? "Duel • Point" : "Match";
      title.textContent = pretty;
    }

    showScreen("screen-multiplayer");

    createMpGrid();
    createMpKeyboard();
    renderMpScoreboard(msg.players || players);

    setMpStatus("Starting in…");

    const startAtMs = (typeof msg.startAt === "number") ? msg.startAt * 1000 : 0;
    if (startAtMs > Date.now()) {
      runCountdownUntil(document.getElementById("mp-countdown"), startAtMs, () => {
        mpActive = selectedMode !== "point";
        mpInputLocked = selectedMode === "point";
        setMpStatus("Match started ✅", 3000);
        mpShowMessage("Go! Type your guesses.");
      });
    } else {
      mpActive = selectedMode !== "point";
      mpInputLocked = selectedMode === "point";
      setMpStatus("Match started ✅", 3000);
      mpShowMessage("Go! Type your guesses.");
    }
    return;
  }

  if (msg.type === "match_state") {
    const playersArr = msg.players || [];
    if (selectedMode === "point") {
      renderPointRoundStatus(playersArr);
      const me = playersArr.find(p => p.name === myName);
      const allRoundDone = playersArr.every(p => p.roundDone);
      const showWait = (msg.betweenRounds || allRoundDone)
        ? "Round complete — waiting for next round…"
        : (me && me.roundDone ? "Waiting for opponent to finish the round…" : null);

      if (showWait) {
        mpActive = false;
        mpInputLocked = true;
        if (roundWaitTimer) clearTimeout(roundWaitTimer);
        roundWaitTimer = setTimeout(() => {
          showMpWaitScreen(showWait);
        }, ROUND_PAUSE_MS);
      } else {
        if (roundWaitTimer) clearTimeout(roundWaitTimer);
        roundWaitTimer = null;
        hideMpWaitScreen();
      }
    } else {
      renderMpScoreboard(playersArr);
      const me = playersArr.find(p => p.name === myName);
      if (me && me.finished) {
        mpActive = false;
        mpInputLocked = true;
        showMpWaitScreen("Waiting for opponent to finish…");
      } else {
        hideMpWaitScreen();
      }
    }
    return;
  }

  if (msg.type === "guess_result") {
    if (!msg.ok) {
      mpShowMessage(msg.error || "Invalid guess");
      return;
    }

    mpColorRow(msg.result);
    mpUpdateKeyboardColors(msg.guess, msg.result);

    if (msg.solved) {
      mpShowMessage("✅ Solved! Next word…", 1500);
      setTimeout(() => mpResetForNextWord(), 700);
      return;
    }

    if (msg.failed) {
      mpShowMessage(`❌ Failed — ${String(msg.answer || "").toUpperCase()}. Next word…`, 1800);
      setTimeout(() => mpResetForNextWord(), 900);
      return;
    }

    mpRow++;
    mpCol = 0;
    return;
  }

  if (msg.type === "match_over") {
    if (roundWaitTimer) clearTimeout(roundWaitTimer);
    roundWaitTimer = null;
    renderMpScoreboard(msg.players || []);
    setMpStatus(`Match Over — Winner: ${msg.winner}`);
    mpShowMessage(`🏆 Winner: ${msg.winner}`, 8000);
    mpActive = false;
    mpInputLocked = true;
    clearMpBoard();
    if (msg.mode === "sprint") {
      const isTie = msg.winner === "Tie";
      const isWinner = !isTie && myName && msg.winner && myName === msg.winner;
      const statsMap = msg.playerStats || {};
      const oppName = Object.keys(statsMap || {}).find(n => n !== myName) || msg.loser || msg.winner;
      const myStats = statsMap ? statsMap[myName] : null;
      const oppStats = statsMap ? statsMap[oppName] : null;
      showMpEndScreenWithStats(
        msg.winner,
        "Duel • Sprint",
        myStats,
        oppName,
        oppStats,
        isWinner,
        isTie,
        "sprint",
        statsMap
      );
    }
    if (msg.mode === "point") {
      const isTie = msg.winner === "Tie";
      const isWinner = !isTie && myName && msg.winner && myName === msg.winner;
      const statsMap = msg.playerStats || {};
      const oppName = Object.keys(statsMap || {}).find(n => n !== myName) || msg.loser || msg.winner;
      const myStats = statsMap ? statsMap[myName] : null;
      const oppStats = statsMap ? statsMap[oppName] : null;
      showMpEndScreenWithStats(
        msg.winner,
        "Duel • Point",
        myStats,
        oppName,
        oppStats,
        isWinner,
        isTie,
        "point",
        statsMap
      );
    }
    clearRoomIdentity();
    try { if (ws) ws.close(); } catch {}
    ws = null;
    hideMpWaitScreen();
    hideMpRoundScreen();
    return;
  }

  if (msg.type === "player_left") {
    if (roundWaitTimer) clearTimeout(roundWaitTimer);
    roundWaitTimer = null;
    const leftName = msg.name || "A player";
    mpActive = false;
    mpInputLocked = true;
    clearRoomState();
    try { if (ws) ws.close(); } catch {}
    ws = null;
    hideMpEndScreen();
    hideMpWaitScreen();
    hideMpRoundScreen();
    showScreen("menu");
    alert(`${leftName} left the room. Match ended.`);
    return;
  }

  if (msg.type === "waiting") {
    mpActive = false;
    mpInputLocked = true;
    if (selectedMode === "point") {
      if (roundWaitTimer) clearTimeout(roundWaitTimer);
      roundWaitTimer = setTimeout(() => {
        showMpWaitScreen(msg.message || "Waiting for opponent to finish…");
      }, ROUND_PAUSE_MS);
    } else {
      showMpWaitScreen(msg.message || "Waiting for opponent to finish…");
    }
    return;
  }

  if (msg.type === "round_over") {
    mpActive = false;
    mpInputLocked = true;
    if (selectedMode === "point") {
      if (roundWaitTimer) clearTimeout(roundWaitTimer);
      roundWaitTimer = setTimeout(() => {
        showMpRoundScreen((msg.round ?? 1), msg.players || []);
        hideMpWaitScreen();
      }, ROUND_PAUSE_MS);
    } else {
      showMpRoundScreen((msg.round ?? 1), msg.players || []);
      hideMpWaitScreen();
    }
    return;
  }

  if (msg.type === "round_start") {
    hideMpRoundScreen();
    hideMpWaitScreen();
    if (roundWaitTimer) clearTimeout(roundWaitTimer);
    roundWaitTimer = null;
    mpActive = true;
    mpInputLocked = false;
    if (selectedMode === "point") {
      renderPointRoundStatus(msg.players || players);
    }
    const btn = document.getElementById("btn-mp-round-ready");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Ready";
    }
    mpRoundReadyPending = false;
    return;
  }

  if (msg.type === "round_ready_state") {
    // If this player hasn't clicked yet, keep the button active.
    return;
  }
}

/****************************************************
 * SCREEN NAVIGATION
 ****************************************************/
function showScreen(screenId) {
  const screens = [
    "menu",
    "screen-competition",
    "screen-duel",
    "screen-create-room",
    "screen-waiting-room",
    "screen-join-room",
    "screen-multiplayer",
    "gameboard"
  ];

  screens.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === screenId) el.classList.remove("hidden");
    else el.classList.add("hidden");
  });
}

/****************************************************
 * CREATE ROOM SCREENS (DUEL)
 ****************************************************/
function openCreateRoomScreen() {
  const nameInput = document.getElementById("create-name");
  if (nameInput) nameInput.value = "";

  const summary = document.getElementById("create-room-summary");
  if (summary) summary.textContent = getCreateRoomSummary(selectedMode);

  showScreen("screen-create-room");
}

function getCreateRoomSummary(mode) {
  if (mode === "sprint") return "Duel • Sprint Battle (Create Room)";
  if (mode === "point") return "Duel • Point Battle (Create Room)";
  return "Duel • Create Room";
}

/****************************************************
 * MENU BUTTONS
 ****************************************************/
function bindMenuButtons() {
  // MAIN
  const btnDaily = document.getElementById("btn-daily");
  const btnCompetition = document.getElementById("btn-competition");

  // COMPETITION
  const btnCompBack = document.getElementById("btn-comp-back");
  const btnDuel = document.getElementById("btn-duel");
  const btnJoinRoom = document.getElementById("btn-join-room");

  // DUEL
  const btnSprint = document.getElementById("btn-sprint");
  const btnPoint = document.getElementById("btn-point");
  const btnDuelBack = document.getElementById("btn-duel-back");

  // DUEL CREATE
  const btnCreateBack = document.getElementById("btn-create-back");
  const btnCreateRoom = document.getElementById("btn-create-room");

  // DUEL WAITING
  const btnWaitingBack = document.getElementById("btn-waiting-back");
  const btnReadyDuel = document.getElementById("btn-start-match");

  // JOIN SCREEN
  const btnJoinBack = document.getElementById("btn-join-back");
  const btnJoinSubmit = document.getElementById("btn-join-submit");

  // GAMEBOARD
  const btnBackGame = document.getElementById("btn-back");

  // MAIN
  if (btnDaily) btnDaily.addEventListener("click", startDailyGame);

  if (btnCompetition) {
    btnCompetition.addEventListener("click", () => {
      clearMenuMessage();
      showScreen("screen-competition");
    });
  }

  // COMPETITION
  if (btnCompBack) btnCompBack.addEventListener("click", () => showScreen("menu"));
  if (btnDuel) btnDuel.addEventListener("click", () => showScreen("screen-duel"));
  if (btnJoinRoom) btnJoinRoom.addEventListener("click", openJoinRoomScreen);

  // DUEL MENU
  if (btnSprint) btnSprint.addEventListener("click", () => { selectedMode = "sprint"; openCreateRoomScreen(); });
  if (btnPoint) btnPoint.addEventListener("click", () => { selectedMode = "point"; openCreateRoomScreen(); });
  if (btnDuelBack) btnDuelBack.addEventListener("click", () => showScreen("screen-competition"));

  // DUEL CREATE
  if (btnCreateBack) btnCreateBack.addEventListener("click", () => showScreen("screen-duel"));
  if (btnCreateRoom) {
    btnCreateRoom.addEventListener("click", () => {
      const name = (document.getElementById("create-name")?.value || "").trim();
      if (!name) return alert("Please enter your name.");

      myName = name;
      ensureWS();

      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener("open", () => wsSend({ action: "create", name, mode: selectedMode }), { once: true });
      } else {
        wsSend({ action: "create", name, mode: selectedMode });
      }
    });
  }

  // DUEL WAITING BACK
  if (btnWaitingBack) {
    btnWaitingBack.addEventListener("click", () => {
      mpActive = false;
      mpInputLocked = true;
      clearRoomIdentity();
      wsSend({ action: "leave" });
      clearRoomState();
      try { if (ws) ws.close(); } catch {}
      ws = null;
      showScreen("menu");
      clearMenuMessage();
    });
  }

  // DUEL READY
  if (btnReadyDuel) btnReadyDuel.addEventListener("click", () => toggleReady());

  // JOIN SCREEN
  if (btnJoinBack) btnJoinBack.addEventListener("click", () => showScreen("screen-competition"));
  if (btnJoinSubmit) btnJoinSubmit.addEventListener("click", handleJoinRoomSubmit);

  // GAMEBOARD BACK
  if (btnBackGame) {
    btnBackGame.addEventListener("click", () => {
      resetGameState();
      showScreen("menu");
    });
  }

  // ✅ LEAVE MATCH
  const btnLeave = document.getElementById("btn-mp-leave");
  if (btnLeave) {
    btnLeave.addEventListener("click", () => {
      mpActive = false;
      mpInputLocked = true;
      clearRoomIdentity();
      wsSend({ action: "leave" });
      clearRoomState();
      try { if (ws) ws.close(); } catch {}
      ws = null;
      showScreen("menu");
      clearMenuMessage();
    });
  }

  const btnMpEndMenu = document.getElementById("btn-mp-end-menu");
  if (btnMpEndMenu) {
    btnMpEndMenu.addEventListener("click", () => {
      hideMpEndScreen();
      mpActive = false;
      mpInputLocked = true;
      clearRoomIdentity();
      clearRoomState();
      try { if (ws) ws.close(); } catch {}
      ws = null;
      showScreen("menu");
      clearMenuMessage();
    });
  }

  const btnRoundReady = document.getElementById("btn-mp-round-ready");
  if (btnRoundReady) {
    btnRoundReady.addEventListener("click", () => {
      if (mpRoundReadyPending) return;
      mpRoundReadyPending = true;
      btnRoundReady.textContent = "Waiting...";
      wsSend({ action: "round_ready" });
    });
  }
}

/****************************************************
 * ROOM STATE HELPERS
 ****************************************************/
function clearRoomState() {
  selectedMode = null;
  roomCode = null;
  players = [];
  maxPlayers = 0;
  myName = null;
  myToken = null;
  clearRoomIdentity();
  hideMpEndScreen();
  hideMpWaitScreen();
  hideMpRoundScreen();
  clearMpBoard();
}

/****************************************************
 * JOIN ROOM SCREEN
 ****************************************************/
function openJoinRoomScreen() {
  const nameInput = document.getElementById("join-name");
  const codeInput = document.getElementById("join-code");
  if (nameInput) nameInput.value = "";
  if (codeInput) codeInput.value = "";
  clearMenuMessage();
  showScreen("screen-join-room");
}

function handleJoinRoomSubmit() {
  const name = (document.getElementById("join-name")?.value || "").trim();
  const code = (document.getElementById("join-code")?.value || "").trim();

  if (!name) return alert("Please enter your name.");
  if (!code) return alert("Please enter a room code.");

  myName = name;
  ensureWS();

  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener("open", () => wsSend({ action: "join", name, roomCode: code }), { once: true });
  } else {
    wsSend({ action: "join", name, roomCode: code });
  }
}

/****************************************************
 * READY TOGGLE (ALL PLAYERS)
 ****************************************************/
function toggleReady() {
  if (!myName || !roomCode) return;

  const readyCount = players.filter(p => p.ready).length;
  if (players.length === maxPlayers && readyCount === maxPlayers) return;

  const me = players.find(p => p.name === myName);
  const current = !!me?.ready;
  const next = !current;

  wsSend({ action: "ready", ready: next });
}

/****************************************************
 * WAITING ROOM UI
 ****************************************************/
function openDuelWaitingRoom() {
  const greet = document.getElementById("waiting-greeting");
  if (greet) greet.textContent = myName ? `Hi, ${myName} 👋` : "Waiting room";

  const codeSpan = document.getElementById("waiting-room-code");
  if (codeSpan) codeSpan.textContent = roomCode || "------";

  showScreen("screen-waiting-room");
}

function updateWaitingUI() {
  const readyCount = players.filter(p => p.ready).length;

  const rulesBox = document.getElementById("waiting-rules");

  if (rulesBox) {
    rulesBox.innerHTML = getDuelRulesHtml(selectedMode);
  }

  renderPlayersList("players-list");

  const btn = document.getElementById("btn-start-match");

  if (btn) {
    const everyoneReady = (players.length === maxPlayers) && (readyCount === maxPlayers);
    if (everyoneReady) {
      btn.textContent = "All Ready ✅";
      btn.disabled = true;
      btn.classList.add("disabled");
    } else {
      btn.textContent = getMyReady() ? "Unready" : "Ready";
      const disabled = players.length < maxPlayers;
      btn.disabled = disabled;
      btn.classList.toggle("disabled", disabled);
    }
  }

  const status = document.getElementById("waiting-status");

  if (status) {
    if (players.length < maxPlayers) {
      status.textContent = `Waiting for players… (${players.length}/${maxPlayers})`;
    } else if (readyCount < maxPlayers) {
      if (getMyReady()) {
        status.textContent = `Waiting for other players to be ready… (${readyCount}/${maxPlayers} ready)`;
      } else {
        status.textContent = `Room full! Click Ready when you're ready. (${readyCount}/${maxPlayers} ready)`;
      }
    } else {
      status.textContent = "All players ready ✅ Starting…";
    }
  }
}

function getMyReady() {
  const me = players.find(p => p.name === myName);
  return !!me?.ready;
}

/****************************************************
 * RULE HTML (DETAILED)
 * Used by waiting room: #waiting-rules
 ****************************************************/

function getDuelRulesHtml(mode) {
  if (mode === "sprint") {
    return `
      <div><strong>Duel • Sprint Battle Rules</strong></div>
      <div style="margin-top:8px;"><strong>How it works:</strong></div>
      <div>• This is a <strong>1v1</strong> race.</div>
      <div>• Both players receive the <strong>exact same 10-word sequence</strong> (same order).</div>
      <div>• You play continuously: when you solve a word, you instantly move to the next one.</div>
      <div>• Each solved word counts as a <strong>win</strong> for that word.</div>

      <div style="margin-top:10px;"><strong>Winning the match:</strong></div>
      <div>• First player to reach <strong>3 wins</strong> wins the match immediately.</div>
      <div>• If nobody reaches 3 wins after all 10 words are played:</div>
      <div style="margin-left:14px;">- The player with <strong>more wins</strong> wins.</div>

      <div style="margin-top:10px;"><strong>Tie-breakers:</strong></div>
      <div>• If wins are tied after 10 words:</div>
      <div style="margin-left:14px;">- Whoever finished the full 10-word list <strong>faster</strong> wins.</div>
      <div>• If both players hit their 3rd win at the “same time”:</div>
      <div style="margin-left:14px;">- The player who used <strong>fewer total guesses</strong> to reach 3 wins wins.</div>
    `;
  }

  if (mode === "point") {
    return `
      <div><strong>Duel • Point Battle Rules</strong></div>
      <div style="margin-top:8px;"><strong>How it works:</strong></div>
      <div>• This is a <strong>1v1</strong> match with <strong>3 rounds</strong>.</div>
      <div>• Both players get the <strong>same word each round</strong> (same round order).</div>
      <div>• Your score depends on how fast you solve each word (fewer tries = more points).</div>

      <div style="margin-top:10px;"><strong>Scoring per round:</strong></div>
      <div>• Solve in 1 try: <strong>7 pts</strong></div>
      <div>• Solve in 2 tries: <strong>5 pts</strong></div>
      <div>• Solve in 3 tries: <strong>4 pts</strong></div>
      <div>• Solve in 4 tries: <strong>3 pts</strong></div>
      <div>• Solve in 5 tries: <strong>2 pts</strong></div>
      <div>• Solve in 6 tries: <strong>1 pt</strong></div>
      <div>• Fail the word (no solve in 6): <strong>-1 pt</strong></div>

      <div style="margin-top:10px;"><strong>Winning the match:</strong></div>
      <div>• After 3 rounds, the player with the <strong>highest total points</strong> wins.</div>
    `;
  }

  return `
    <div><strong>Duel Rules</strong></div>
    <div>• Select a Duel mode to view the rules.</div>
  `;
}

/****************************************************
 * PLAYERS LIST (with READY tick)
 ****************************************************/
function renderPlayersList(listId) {
  const list = document.getElementById(listId);
  if (!list) return;

  list.innerHTML = "";

  players.forEach(p => {
    const li = document.createElement("li");
    li.textContent = p.name;

    if (p.isHost) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "HOST";
      li.appendChild(badge);
    }

    if (p.ready) {
      const readyBadge = document.createElement("span");
      readyBadge.className = "badge badge-ready";
      readyBadge.textContent = "READY ✓";
      li.appendChild(readyBadge);
    }

    list.appendChild(li);
  });
}

/****************************************************
 * MENU MESSAGE HELPERS
 ****************************************************/
function setMenuMessage(text) {
  const el = document.getElementById("menu-message");
  if (el) el.textContent = text;
}
function clearMenuMessage() { setMenuMessage(""); }

/****************************************************
 * WORD OF THE DAY START
 ****************************************************/
function startDailyGame() {
  resetGameState();
  createGrid();
  createKeyboard();
  showScreen("gameboard");
  inputLocked = true;
  dailyCountdownUntil = Date.now() + 3000;
  saveDailyState();
  runCountdownUntil(document.getElementById("countdown"), dailyCountdownUntil, () => {
    inputLocked = false;
    dailyCountdownUntil = null;
    saveDailyState();
  });
}

/****************************************************
 * RESET GAME STATE
 ****************************************************/
function resetGameState() {
  currentRow = 0;
  currentCol = 0;
  gameOver = false;
  isSubmitting = false;
  keyState = {};
  inputLocked = false;
  mpInputLocked = false;
  dailyCountdownUntil = null;

  clearEndgameMessage();

  const msg = document.getElementById("messages");
  if (msg) {
    msg.textContent = "";
    msg.classList.remove("show");
  }

  if (messageTimer) clearTimeout(messageTimer);

  const grid = document.getElementById("grid");
  if (grid) grid.innerHTML = "";

  ["kb-row-1", "kb-row-2", "kb-row-3", "mp-kb-row-1", "mp-kb-row-2", "mp-kb-row-3"].forEach(id => {
    const row = document.getElementById(id);
    if (row) row.innerHTML = "";
  });

  clearDailyState();
}

/****************************************************
 * TEMP MESSAGE (Daily)
 ****************************************************/
function showMessage(text, ms = 4000) {
  const msg = document.getElementById("messages");
  if (!msg) return;

  msg.textContent = text;
  msg.classList.add("show");

  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    msg.classList.remove("show");
    msg.textContent = "";
  }, ms);
}

/****************************************************
 * ENDGAME MESSAGES
 ****************************************************/
function showWin() {
  const end = document.getElementById("endgame");
  if (!end) return;

  end.className = "win";
  end.innerHTML = "🎉 You Win!";
  end.style.display = "block";
  clearDailyKeyboard();
  saveDailyState({ endgame: { status: "win" } });
}

function showLose(answer) {
  const end = document.getElementById("endgame");
  if (!end) return;

  end.className = "lose";
  end.innerHTML = `❌ You Lose <span class="answer">Answer: ${answer.toUpperCase()}</span>`;
  end.style.display = "block";
  clearDailyKeyboard();
  saveDailyState({ endgame: { status: "lose", answer } });
}

function clearEndgameMessage() {
  const end = document.getElementById("endgame");
  if (!end) return;

  end.style.display = "none";
  end.className = "";
  end.innerHTML = "";
}

/****************************************************
 * KEYBOARD INPUT (Daily + Multiplayer)
 ****************************************************/
function bindKeyboard() {
  const kb = document.getElementById("keyboard");
  if (kb) {
    kb.addEventListener("click", (e) => {
      const btn = e.target.closest(".key");
      if (!btn) return;
      handleKey({ key: btn.dataset.key });
    });
  }

  const mpKb = document.getElementById("mp-keyboard");
  if (mpKb) {
    mpKb.addEventListener("click", (e) => {
      const btn = e.target.closest(".key");
      if (!btn) return;
      handleKey({ key: btn.dataset.key });
    });
  }
}

function handleKey(e) {
  // Multiplayer input
  const mpScreen = document.getElementById("screen-multiplayer");
  const mpVisible = mpScreen && !mpScreen.classList.contains("hidden");
  if (mpVisible) {
    if (!mpActive || mpInputLocked) return;

    const key = e.key;

    if (key === "Backspace") {
      if (mpCol === 0) return;
      mpCol--;
      const cell = document.getElementById(`mp-cell-${mpRow}-${mpCol}`);
      if (cell) cell.textContent = "";
      return;
    }

    if (key === "Enter") {
      if (mpCol !== 5) {
        mpShowMessage("Not enough letters");
        return;
      }
      const guess = mpGetCurrentGuess();
      wsSend({ action: "guess", guess });
      return;
    }

    if (!/^[a-zA-Z]$/.test(key)) return;
    if (mpCol >= 5) return;

    const cell = document.getElementById(`mp-cell-${mpRow}-${mpCol}`);
    if (!cell) return;

    cell.textContent = key.toUpperCase();
    mpCol++;
    return;
  }

  // Daily input
  const gameboard = document.getElementById("gameboard");
  if (!gameboard || gameboard.classList.contains("hidden")) return;
  if (inputLocked) return;
  if (gameOver) return;

  const key = e.key;

  if (key === "Backspace") {
    if (currentCol === 0) return;
    currentCol--;
    const cell = document.getElementById(`cell-${currentRow}-${currentCol}`);
    if (cell) cell.textContent = "";
    saveDailyState();
    return;
  }

  if (key === "Enter") {
    if (isSubmitting) return;

    if (currentCol !== 5) {
      showMessage("Not enough letters");
      return;
    }

    submitGuess(getCurrentGuess());
    return;
  }

  if (!/^[a-zA-Z]$/.test(key)) return;
  if (currentCol >= 5) return;

  const cell = document.getElementById(`cell-${currentRow}-${currentCol}`);
  if (!cell) return;

  cell.textContent = key.toUpperCase();
  currentCol++;
  saveDailyState();
}

/****************************************************
 * GRID & KEYBOARD CREATION
 ****************************************************/
function createGrid() {
  const grid = document.getElementById("grid");
  if (!grid) return;

  grid.innerHTML = "";

  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 5; c++) {
      const cell = document.createElement("div");
      cell.className = "cell board-cell";
      cell.id = `cell-${r}-${c}`;
      grid.appendChild(cell);
    }
  }
}

function createKeyboard() {
  buildKeyboardRow("kb-row-1", "QWERTYUIOP".split(""));
  buildKeyboardRow("kb-row-2", "ASDFGHJKL".split(""));
  buildKeyboardRow("kb-row-3", ["Enter", ..."ZXCVBNM".split(""), "Backspace"]);
}

function buildKeyboardRow(id, keys) {
  const row = document.getElementById(id);
  if (!row) return;

  row.innerHTML = "";

  keys.forEach(k => {
    const btn = document.createElement("button");
    btn.className = "key";
    if (k === "Enter" || k === "Backspace") btn.classList.add("wide");

    btn.textContent = k === "Backspace" ? "⌫" : k;
    btn.dataset.key = k;

    if (k.length === 1) btn.id = `key-${k}`;
    row.appendChild(btn);
  });
}

/****************************************************
 * GUESS HELPERS (Daily)
 ****************************************************/
function getCurrentGuess() {
  let guess = "";
  for (let i = 0; i < 5; i++) {
    const cell = document.getElementById(`cell-${currentRow}-${i}`);
    guess += (cell?.textContent || "").toLowerCase();
  }
  return guess;
}

function colorRow(result) {
  for (let i = 0; i < 5; i++) {
    const cell = document.getElementById(`cell-${currentRow}-${i}`);
    if (!cell) continue;
    cell.classList.remove("correct", "present", "absent");
    cell.classList.add(result[i]);
  }
  saveDailyState();
}

function updateKeyboardColors(guess, result) {
  for (let i = 0; i < 5; i++) {
    const letter = guess[i].toUpperCase();
    const newState = result[i];
    const oldState = keyState[letter];

    if (!oldState || keyRank[newState] > keyRank[oldState]) {
      keyState[letter] = newState;
      const keyBtn = document.getElementById(`key-${letter}`);
      if (keyBtn) {
        keyBtn.classList.remove("absent", "present", "correct");
        keyBtn.classList.add(newState);
      }
    }
  }
  saveDailyState();
}

/****************************************************
 * SUBMIT GUESS (Daily)
 ****************************************************/
async function submitGuess(guess) {
  isSubmitting = true;

  try {
    const res = await fetch("/api/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guess, row: currentRow })
    });

    const data = await res.json();

    if (!data.ok) {
      showMessage(data.error);
      return;
    }

    colorRow(data.result);
    updateKeyboardColors(guess, data.result);

    if (data.isWin) {
      gameOver = true;
      showWin();
      return;
    }

    if (currentRow === 5) {
      gameOver = true;
      showLose(data.answer || "?????");
      return;
    }

    currentRow++;
    currentCol = 0;
    saveDailyState();

  } catch (err) {
    console.error(err);
    showMessage("Server error");
  } finally {
    isSubmitting = false;
  }
}

/****************************************************
 * MULTIPLAYER UI HELPERS
 ****************************************************/
function createMpGrid() {
  const grid = document.getElementById("mp-grid");
  if (!grid) return;

  grid.innerHTML = "";
  grid.style.display = "grid";

  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 5; c++) {
      const cell = document.createElement("div");
      cell.className = "mp-cell board-cell";
      cell.id = `mp-cell-${r}-${c}`;
      grid.appendChild(cell);
    }
  }
}

function createMpKeyboard() {
  buildKeyboardRow("mp-kb-row-1", "QWERTYUIOP".split(""));
  buildKeyboardRow("mp-kb-row-2", "ASDFGHJKL".split(""));
  buildKeyboardRow("mp-kb-row-3", ["Enter", ..."ZXCVBNM".split(""), "Backspace"]);
}

function mpShowMessage(text, ms = 3500) {
  const msg = document.getElementById("mp-messages");
  if (!msg) return;

  msg.textContent = text;
  msg.classList.add("show");

  setTimeout(() => {
    msg.classList.remove("show");
    msg.textContent = "";
  }, ms);
}

/****************************************************
 * COUNTDOWN
 ****************************************************/
function runCountdownUntil(el, endMs, done) {
  if (!el) {
    if (done) done();
    return;
  }

  const numEl = el.querySelector(".countdown-number");
  document.body.classList.add("countdown-active");

  const tick = () => {
    const remaining = endMs - Date.now();
    if (remaining <= 0) {
      if (numEl) numEl.textContent = "GO!";
      else el.textContent = "GO!";
      el.classList.add("show");
      setTimeout(() => {
        el.classList.remove("show");
        if (numEl) numEl.textContent = "";
        else el.textContent = "";
        document.body.classList.remove("countdown-active");
        if (done) done();
      }, 400);
      return;
    }

    const n = Math.ceil(remaining / 1000);
    if (numEl) numEl.textContent = String(Math.min(3, n));
    else el.textContent = String(Math.min(3, n));
    el.classList.add("show");
    setTimeout(tick, 200);
  };

  tick();
}

function setMpStatus(text, ms = 0) {
  const st = document.getElementById("mp-status");
  if (!st) return;
  st.textContent = text || "";
  if (mpStatusTimer) clearTimeout(mpStatusTimer);
  if (ms > 0) {
    mpStatusTimer = setTimeout(() => {
      st.textContent = "";
    }, ms);
  }
}

/****************************************************
 * LOCAL STORAGE (ROOM)
 ****************************************************/
function persistRoomIdentity() {
  if (!roomCode || !myName || !myToken) return;
  const payload = { roomCode, name: myName, token: myToken };
  try { localStorage.setItem(STORAGE_ROOM, JSON.stringify(payload)); } catch {}
}

function clearRoomIdentity() {
  try { localStorage.removeItem(STORAGE_ROOM); } catch {}
}

/****************************************************
 * LOCAL STORAGE (DAILY)
 ****************************************************/
function getEdmontonDateString() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date());
}

function saveDailyState(extra = {}) {
  const grid = document.getElementById("grid");
  if (!grid) return;

  const rows = [];
  for (let r = 0; r < 6; r++) {
    const letters = [];
    const states = [];
    for (let c = 0; c < 5; c++) {
      const cell = document.getElementById(`cell-${r}-${c}`);
      letters.push(cell?.textContent || "");
      if (cell?.classList.contains("correct")) states.push("correct");
      else if (cell?.classList.contains("present")) states.push("present");
      else if (cell?.classList.contains("absent")) states.push("absent");
      else states.push("");
    }
    rows.push({ letters, states });
  }

  const payload = {
    date: getEdmontonDateString(),
    currentRow,
    currentCol,
    gameOver,
    keyState,
    grid: rows,
    endgame: extra.endgame || null,
    countdownUntil: dailyCountdownUntil
  };

  try { localStorage.setItem(STORAGE_DAILY, JSON.stringify(payload)); } catch {}
}

function clearDailyState() {
  try { localStorage.removeItem(STORAGE_DAILY); } catch {}
}

function isRefreshNavigation() {
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav && nav.type) return nav.type === "reload";
  } catch {}
  try {
    return performance.navigation && performance.navigation.type === 1;
  } catch {}
  return false;
}

function tryAutoResumeOnRefresh() {
  if (!isRefreshNavigation()) return;
  // Always land on main menu after refresh.
  clearRoomIdentity();
  clearMenuMessage();
}

function mpGetCurrentGuess() {
  let guess = "";
  for (let i = 0; i < 5; i++) {
    const cell = document.getElementById(`mp-cell-${mpRow}-${i}`);
    guess += (cell?.textContent || "").toLowerCase();
  }
  return guess;
}

function mpColorRow(result) {
  for (let i = 0; i < 5; i++) {
    const cell = document.getElementById(`mp-cell-${mpRow}-${i}`);
    if (!cell) continue;
    cell.classList.remove("correct", "present", "absent");
    cell.classList.add(result[i]);
  }
}

function mpUpdateKeyboardColors(guess, result) {
  updateKeyboardColors(guess, result);
}

function mpResetForNextWord() {
  mpRow = 0;
  mpCol = 0;
  keyState = {};

  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 5; c++) {
      const cell = document.getElementById(`mp-cell-${r}-${c}`);
      if (!cell) continue;
      cell.textContent = "";
      cell.classList.remove("correct", "present", "absent");
    }
  }

  "QWERTYUIOPASDFGHJKLZXCVBNM".split("").forEach(ch => {
    const keyBtn = document.getElementById(`key-${ch}`);
    if (keyBtn) keyBtn.classList.remove("absent", "present", "correct");
  });
}

function renderMpScoreboard(playersArr) {
  const list = document.getElementById("mp-scoreboard");
  if (!list) return;

  list.innerHTML = "";
  const visiblePlayers = (selectedMode === "sprint")
    ? (playersArr || []).filter(p => p.name === myName)
    : (playersArr || []);

  visiblePlayers.forEach(p => {
    const li = document.createElement("li");

    const left = document.createElement("span");
    left.textContent = p.name;

    const right = document.createElement("span");
    const wins = (typeof p.wins === "number") ? p.wins : 0;
    const pts = (typeof p.points === "number") ? p.points : 0;
    const widx = (typeof p.wordIndex === "number") ? p.wordIndex : 0;

    if (selectedMode === "point") {
      right.textContent = `Pts: ${pts} • Round: ${Math.min(widx + 1, 3)}/3`;
    } else {
      right.textContent = `Wins: ${wins} • Word: ${Math.min(widx + 1, 10)}/10`;
    }

    li.appendChild(left);
    li.appendChild(right);

    if (p.isHost) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "HOST";
      li.appendChild(badge);
    }

    list.appendChild(li);
  });
}

function renderPointRoundStatus(playersArr) {
  const list = document.getElementById("mp-scoreboard");
  if (!list) return;

  list.innerHTML = "";

  (playersArr || []).forEach(p => {
    const li = document.createElement("li");

    const left = document.createElement("span");
    left.textContent = p.name;

    const right = document.createElement("span");
    if (p.roundDone) {
      right.textContent = "Finished";
    } else {
      right.textContent = "Playing…";
    }

    li.appendChild(left);
    li.appendChild(right);
    list.appendChild(li);
  });
}

function showMpEndScreen(winner, subtitle, isWinner, isTie) {
  const overlay = document.getElementById("mp-end");
  const titleEl = document.getElementById("mp-end-title");
  const winEl = document.getElementById("mp-end-winner");
  const subEl = document.getElementById("mp-end-subtitle");
  mpEndOpen = true;
  if (titleEl) titleEl.textContent = isTie ? "Tie Game" : (isWinner ? "You Won!" : "You Lost");
  if (winEl) winEl.textContent = isTie ? "Result: Tie" : `Winner: ${winner}`;
  if (subEl) subEl.textContent = subtitle || "";
  if (overlay) overlay.classList.remove("hidden");
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds)) return "--";
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}

function showMpEndScreenWithStats(winner, subtitle, myStats, oppName, oppStats, isWinner, isTie, mode, statsMap) {
  showMpEndScreen(winner, subtitle, isWinner, isTie);
  const yourNameEl = document.getElementById("mp-end-your-name");
  const yourTimeEl = document.getElementById("mp-end-your-time");
  const yourSolvedEl = document.getElementById("mp-end-your-solved");
  const yourWordsEl = document.getElementById("mp-end-your-words");
  const yourPointsEl = document.getElementById("mp-end-your-points");
  const oppNameEl = document.getElementById("mp-end-opponent-name");
  const oppTimeEl = document.getElementById("mp-end-opponent-time");
  const oppSolvedEl = document.getElementById("mp-end-opponent-solved");
  const oppWordsEl = document.getElementById("mp-end-opponent-words");
  const oppPointsEl = document.getElementById("mp-end-opponent-points");
  const roundWrap = document.getElementById("mp-end-round-wrap");
  const roundBody = document.getElementById("mp-end-round-table-body");

  const yourName = myName || "--";
  const oppNameSafe = oppName || "--";

  if (yourNameEl) yourNameEl.textContent = `Name: ${yourName}`;
  if (yourTimeEl) yourTimeEl.textContent = `Time: ${formatDuration(myStats?.durationSeconds)}`;
  if (yourSolvedEl) {
    const solved = (typeof myStats?.wins === "number") ? myStats.wins : null;
    yourSolvedEl.textContent = `Words Solved: ${solved !== null ? solved : "--"}`;
  }
  if (yourWordsEl) {
    const words = (typeof myStats?.wordIndex === "number") ? myStats.wordIndex : null;
    yourWordsEl.textContent = `Total Words Attempted: ${words !== null ? words : "--"}`;
  }
  if (yourPointsEl) {
    const pts = (typeof myStats?.points === "number") ? myStats.points : null;
    yourPointsEl.textContent = `Total Points: ${pts !== null ? pts : "--"}`;
  }

  if (oppNameEl) oppNameEl.textContent = `Name: ${oppNameSafe}`;
  if (oppTimeEl) oppTimeEl.textContent = `Time: ${formatDuration(oppStats?.durationSeconds)}`;
  if (oppSolvedEl) {
    const solved = (typeof oppStats?.wins === "number") ? oppStats.wins : null;
    oppSolvedEl.textContent = `Words Solved: ${solved !== null ? solved : "--"}`;
  }
  if (oppWordsEl) {
    const words = (typeof oppStats?.wordIndex === "number") ? oppStats.wordIndex : null;
    oppWordsEl.textContent = `Total Words Attempted: ${words !== null ? words : "--"}`;
  }
  if (oppPointsEl) {
    const pts = (typeof oppStats?.points === "number") ? oppStats.points : null;
    oppPointsEl.textContent = `Total Points: ${pts !== null ? pts : "--"}`;
  }

  if (roundWrap && roundBody) {
    if (mode === "point") {
      roundWrap.classList.remove("hidden");
      roundBody.innerHTML = "";
      const rows = Object.entries(statsMap || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      rows.forEach(([name, st]) => {
        const tr = document.createElement("tr");
        const tdName = document.createElement("td");
        const tdR1 = document.createElement("td");
        const tdR2 = document.createElement("td");
        const tdR3 = document.createElement("td");
        const tdTotal = document.createElement("td");
        const rpts = Array.isArray(st?.roundPoints) ? st.roundPoints : [null, null, null];
        tdName.textContent = name;
        tdR1.textContent = (rpts[0] == null) ? "-" : String(rpts[0]);
        tdR2.textContent = (rpts[1] == null) ? "-" : String(rpts[1]);
        tdR3.textContent = (rpts[2] == null) ? "-" : String(rpts[2]);
        tdTotal.textContent = String(st?.points ?? 0);
        tr.appendChild(tdName);
        tr.appendChild(tdR1);
        tr.appendChild(tdR2);
        tr.appendChild(tdR3);
        tr.appendChild(tdTotal);
        roundBody.appendChild(tr);
      });
    } else {
      roundWrap.classList.add("hidden");
      roundBody.innerHTML = "";
    }
  }
}

function hideMpEndScreen() {
  const overlay = document.getElementById("mp-end");
  if (overlay) overlay.classList.add("hidden");
  mpEndOpen = false;
}

function showMpWaitScreen(message) {
  const overlay = document.getElementById("mp-wait");
  if (!overlay) return;
  const subtitle = overlay.querySelector(".end-subtitle");
  if (subtitle) subtitle.textContent = message || "Waiting for opponent to finish…";
  overlay.classList.remove("hidden");
  document.body.classList.add("round-overlay-active");
}

function hideMpWaitScreen() {
  const overlay = document.getElementById("mp-wait");
  if (overlay) overlay.classList.add("hidden");
  const round = document.getElementById("mp-round");
  if (!round || round.classList.contains("hidden")) {
    document.body.classList.remove("round-overlay-active");
  }
}

function showMpRoundScreen(roundNum, playersArr) {
  const overlay = document.getElementById("mp-round");
  if (!overlay) return;
  const title = document.getElementById("mp-round-title");
  const subtitle = document.getElementById("mp-round-subtitle");
  const tbody = document.getElementById("mp-round-table-body");
  const btn = document.getElementById("btn-mp-round-ready");
  if (title) title.textContent = roundNum <= 0 ? "Ready to Start Round 1" : `Round ${roundNum} Complete`;
  if (subtitle) subtitle.textContent = roundNum === 0 ? "Both players ready up to begin." : "Ready for next round?";
  if (tbody) {
    tbody.innerHTML = "";
    const rows = (playersArr || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    rows.forEach(p => {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      const tdR1 = document.createElement("td");
      const tdR2 = document.createElement("td");
      const tdR3 = document.createElement("td");
      const tdTotal = document.createElement("td");
      tdName.textContent = p.name;
      const rpts = Array.isArray(p.roundPoints) ? p.roundPoints : [null, null, null];
      tdR1.textContent = (rpts[0] == null) ? "-" : String(rpts[0]);
      tdR2.textContent = (rpts[1] == null) ? "-" : String(rpts[1]);
      tdR3.textContent = (rpts[2] == null) ? "-" : String(rpts[2]);
      tdTotal.textContent = String(p.points ?? 0);
      tr.appendChild(tdName);
      tr.appendChild(tdR1);
      tr.appendChild(tdR2);
      tr.appendChild(tdR3);
      tr.appendChild(tdTotal);
      tbody.appendChild(tr);
    });
  }
  if (btn) {
    btn.textContent = "Ready";
  }
  mpRoundReadyPending = false;
  overlay.classList.remove("hidden");
  document.body.classList.add("round-overlay-active");
}

function hideMpRoundScreen() {
  const overlay = document.getElementById("mp-round");
  if (overlay) overlay.classList.add("hidden");
  const wait = document.getElementById("mp-wait");
  if (!wait || wait.classList.contains("hidden")) {
    document.body.classList.remove("round-overlay-active");
  }
}

function clearDailyKeyboard() {
  ["kb-row-1", "kb-row-2", "kb-row-3"].forEach(id => {
    const row = document.getElementById(id);
    if (row) row.innerHTML = "";
  });
}

function clearMpBoard() {
  const grid = document.getElementById("mp-grid");
  if (grid) grid.innerHTML = "";
  const msg = document.getElementById("mp-messages");
  if (msg) {
    msg.textContent = "";
    msg.classList.remove("show");
  }
  ["mp-kb-row-1", "mp-kb-row-2", "mp-kb-row-3"].forEach(id => {
    const row = document.getElementById(id);
    if (row) row.innerHTML = "";
  });
}
